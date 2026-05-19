#!/usr/bin/env python3
"""
ULTIMATE Generalized Am Jur / Legal Book Pre-OCR Processor v2
Improved block detection to capture bottom portions of columns.
"""

import os
import json
from pathlib import Path
from typing import List, Dict, Tuple

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
from scipy import ndimage


class LegalBookPreOCR:
    def __init__(self, output_dir: str = "preocr_final_v2"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True, parents=True)

    def load_image(self, path: str) -> np.ndarray:
        return np.array(Image.open(path).convert('L'), dtype=np.uint8)

    def detect_page_type(self, img: np.ndarray) -> str:
        h, w = img.shape
        binary = (img < 140).astype(np.uint8) * 255
        ink_density = np.mean(binary == 0)
        col_density = np.mean(np.sum(binary == 0, axis=0) > h*0.08)

        if ink_density > 0.095 or w < 1100:
            return "dense_index"
        elif col_density > 0.75:
            return "two_column_body"
        elif ink_density > 0.07 and h > 1800:
            return "toc_outline"
        else:
            return "general_legal"

    def deskew(self, img: np.ndarray):
        try:
            import cv2
            binary = (img < 140).astype(np.uint8) * 255
            coords = np.column_stack(np.where(binary > 0))
            if len(coords) < 200:
                return img, 0.0
            rect = cv2.minAreaRect(coords)
            angle = rect[2]
            if angle < -45:
                angle = -(90 + angle)
            else:
                angle = -angle
            (h, w) = img.shape
            M = cv2.getRotationMatrix2D((w//2, h//2), angle, 1.0)
            rotated = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC,
                                   borderMode=cv2.BORDER_REPLICATE)
            return rotated, float(angle)
        except:
            return img, 0.0

    def enhance_and_binary(self, img: np.ndarray):
        p2, p98 = np.percentile(img, (1, 99))
        enhanced = np.clip((img.astype(float) - p2) * (255 / (p98 - p2)), 0, 255).astype(np.uint8)
        enhanced = ndimage.grey_opening(enhanced, size=(2, 2))

        binary = np.zeros_like(img, dtype=np.uint8)
        h, w = img.shape
        for y in range(0, h, 20):
            for x in range(0, w, 20):
                y1, y2 = max(0, y), min(h, y + 55)
                x1, x2 = max(0, x), min(w, x + 55)
                tile = enhanced[y1:y2, x1:x2]
                if tile.size > 50:
                    thresh = np.mean(tile) - 13
                    binary[y1:y2, x1:x2] = (enhanced[y1:y2, x1:x2] < thresh).astype(np.uint8) * 255
        return enhanced, binary

    def get_params(self, page_type: str):
        # v2: More aggressive detection for dense_index pages
        if page_type == "dense_index":
            return {"base_scale": 3.65, "min_h": 18, "gap": 4, "col_gap": 20}
        elif page_type == "toc_outline":
            return {"base_scale": 3.4, "min_h": 16, "gap": 5, "col_gap": 25}
        else:
            return {"base_scale": 3.2, "min_h": 28, "gap": 7, "col_gap": 30}

    def split_columns(self, binary: np.ndarray, page_type: str):
        params = self.get_params(page_type)
        h, w = binary.shape
        proj = np.sum(binary == 0, axis=0)
        gaps = np.where(proj < h * 0.05)[0]

        splits = [0]
        for i in range(1, len(gaps)):
            if gaps[i] - gaps[i-1] > params["col_gap"]:
                splits.append(gaps[i])
        splits.append(w)

        columns = []
        for i in range(len(splits)-1):
            left, right = splits[i], splits[i+1]
            if right - left > w * 0.15:
                columns.append((left, 0, right - left, h))

        if len(columns) <= 1 and w > 1200:
            mid = w // 2
            columns = [(25, 0, mid-40, h), (mid+30, 0, w - mid - 50, h)]
        return columns

    def detect_blocks(self, binary: np.ndarray, cx: int, cw: int, page_type: str):
        params = self.get_params(page_type)
        col_bin = binary[:, cx:cx + cw]
        vproj = np.sum(col_bin == 0, axis=1)

        blocks = []
        start = None
        for i in range(len(vproj) + 1):
            if i < len(vproj) and vproj[i] > params["gap"] and start is None:
                start = i
            elif (i == len(vproj) or vproj[i] <= params["gap"]) and start is not None:
                end = i
                if end - start >= params["min_h"]:
                    row_slice = col_bin[start:end]
                    xs = np.where(np.any(row_slice == 0, axis=0))[0]
                    if len(xs) > 3:
                        x_min = int(xs.min() + cx)
                        x_max = int(xs.max() + cx)
                        blocks.append({
                            "bbox": (x_min, int(start), int(x_max - x_min + 1), int(end - start)),
                            "type": "block"
                        })
                start = None

        page_h = binary.shape[0]
        for b in blocks:
            _, y, _, ht = b["bbox"]
            if ht < 40 or page_type in ["dense_index", "toc_outline"]:
                b["type"] = "footnote_or_index"
            elif y < page_h * 0.08:
                b["type"] = "header"
        return blocks

    def process_slice(self, orig_img: np.ndarray, bbox: Tuple, scale: float):
        x, y, w, h = bbox
        slice_arr = orig_img[y:y+h, x:x+w]
        pil = Image.fromarray(slice_arr)
        magnified = pil.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        sharpened = magnified.filter(ImageFilter.UnsharpMask(radius=2.0, percent=280, threshold=3))
        final = ImageEnhance.Contrast(sharpened).enhance(2.4)
        return final

    def process_image(self, image_path: str):
        print(f"\nProcessing v2: {Path(image_path).name}")
        base_name = Path(image_path).stem

        img = self.load_image(image_path)
        page_type = self.detect_page_type(img)
        print(f"   Page type detected: **{page_type.upper()}**")
        print(f"   Image shape: {img.shape}")

        deskewed, angle = self.deskew(img)
        enhanced, binary = self.enhance_and_binary(deskewed)

        Image.fromarray(deskewed).save(self.output_dir / f"{base_name}_deskewed_v2.png")
        Image.fromarray(binary).save(self.output_dir / f"{base_name}_binary_v2.png")
        print(f"   Saved deskewed and binary images")

        columns = self.split_columns(binary, page_type)
        print(f"   Found {len(columns)} columns")
        
        metadata = []
        slice_id = 0

        for col_idx, (cx, _, cw, _) in enumerate(columns):
            blocks = self.detect_blocks(binary, cx, cw, page_type)
            print(f"   Column {col_idx}: found {len(blocks)} blocks")
            
            for block in blocks:
                btype = block["type"]
                params = self.get_params(page_type)
                scale = params["base_scale"] * (1.65 if btype == "footnote_or_index" else 1.0)

                final_slice = self.process_slice(deskewed, block["bbox"], scale)
                slice_path = self.output_dir / f"{base_name}_slice_v2_{slice_id:03d}_{btype}.png"
                final_slice.save(slice_path)
                print(f"     Saved: {slice_path.name}")

                metadata.append({
                    "slice_id": slice_id,
                    "page_type": page_type,
                    "original_bbox": block["bbox"],
                    "block_type": btype,
                    "scale_factor": round(scale, 2),
                    "column_idx": col_idx,
                    "slice_path": slice_path.name,
                    "deskew_angle": round(angle, 2)
                })
                slice_id += 1

        with open(self.output_dir / f"{base_name}_metadata_v2.json", "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2)

        print(f"Completed v2: {slice_id} high-quality slices\n")


if __name__ == "__main__":
    processor = LegalBookPreOCR(output_dir="preocr_final_v2")
    
    # Use the full path to the image
    image_path = r"C:\Users\Owner\Documents\Josef's Law Collection\11 Am Jur 1d Const Law\iCloud Photos\IMG_2115.JPEG"
    if Path(image_path).exists():
        processor.process_image(image_path)
    else:
        print(f"Image not found: {image_path}")