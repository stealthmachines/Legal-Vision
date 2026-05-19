#!/usr/bin/env python3
"""
ULTIMATE LEGAL BOOK Pre-OCR Processor - Full Stand-Alone Version
Handles: Rotation, Two-page spreads, Continuous columns, Line strips, Full page
"""

import os
import json
from pathlib import Path
from typing import List, Dict, Tuple

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
from scipy import ndimage


class LegalBookPreOCR:
    def __init__(self, output_dir: str = "preocr_final"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)

    def load_image(self, path: str) -> np.ndarray:
        return np.array(Image.open(path).convert('L'), dtype=np.uint8)

    def correct_orientation(self, img: np.ndarray) -> Tuple[np.ndarray, int]:
        """Auto-detect and correct 90/180/270 degree rotations"""
        try:
            import cv2
            h, w = img.shape
            best_img = img.copy()
            best_score = -np.inf
            best_angle = 0

            for angle, rot_flag in [(0, None), (90, cv2.ROTATE_90_CLOCKWISE),
                                  (180, cv2.ROTATE_180), (270, cv2.ROTATE_90_COUNTERCLOCKWISE)]:
                if rot_flag is None:
                    rotated = img.copy()
                else:
                    rotated = cv2.rotate(img, rot_flag)

                binary = (rotated < 140).astype(np.uint8) * 255
                proj = np.sum(binary == 0, axis=0)
                score = np.max(proj) - np.mean(proj) + (np.std(proj) * 0.5)

                if score > best_score:
                    best_score = score
                    best_img = rotated
                    best_angle = angle
            if best_angle != 0:
                print(f"   Auto-rotated by {best_angle}°")
            return best_img, best_angle
        except:
            return img, 0

    def deskew(self, img: np.ndarray) -> Tuple[np.ndarray, float]:
        try:
            import cv2
            binary = (img < 140).astype(np.uint8) * 255
            coords = np.column_stack(np.where(binary > 0))
            if len(coords) < 300:
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

    def detect_and_split_pages(self, img: np.ndarray) -> List[Tuple[int, int, int, int]]:
        """Detect and split two-page spreads"""
        h, w = img.shape
        if w < h * 1.55:  # Not wide enough for spread
            return [(0, 0, w, h)]

        binary = (img < 140).astype(np.uint8) * 255
        proj = np.sum(binary == 0, axis=0)

        mid_start = w // 4
        mid_end = 3 * w // 4
        gutter_region = proj[mid_start:mid_end]
        gutter_idx = np.argmin(gutter_region)
        gutter_x = mid_start + gutter_idx

        if np.min(gutter_region) < h * 0.085:  # Strong gutter detected
            print(f"   Two-page spread detected → split at x≈{gutter_x}")
            left = (0, 0, gutter_x - 25, h)
            right = (gutter_x + 25, 0, w - gutter_x - 25, h)
            return [left, right]
        return [(0, 0, w, h)]

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

    def get_columns(self, binary: np.ndarray) -> List[Tuple]:
        h, w = binary.shape
        proj = np.sum(binary == 0, axis=0)
        gaps = np.where(proj < h * 0.06)[0]

        splits = [0]
        for i in range(1, len(gaps)):
            if gaps[i] - gaps[i-1] > 40:
                splits.append(gaps[i])
        splits.append(w)

        columns = []
        for i in range(len(splits)-1):
            left, right = splits[i], splits[i+1]
            if right - left > w * 0.18:
                col_bin = binary[:, left:right]
                vproj = np.sum(col_bin == 0, axis=1)
                text_rows = np.where(vproj > 5)[0]
                if len(text_rows) > 50:
                    top = max(0, text_rows.min() - 20)
                    bottom = min(h, text_rows.max() + 20)
                    columns.append((left, top, right - left, bottom - top))
        return columns

    def get_line_strips(self, binary: np.ndarray) -> List[Tuple]:
        h, w = binary.shape
        vproj = np.sum(binary == 0, axis=1)
        strips = []
        start = None
        for i in range(len(vproj) + 1):
            if i < len(vproj) and vproj[i] > 7 and start is None:
                start = i
            elif (i == len(vproj) or vproj[i] <= 6) and start is not None:
                end = i
                if end - start >= 25:
                    row_slice = binary[start:end, :]
                    xs = np.where(np.any(row_slice == 0, axis=0))[0]
                    if len(xs) > 15:
                        strips.append((xs.min(), start, xs.max() - xs.min() + 1, end - start))
                start = None
        return strips

    def process_slice(self, orig_img: np.ndarray, bbox: Tuple, scale: float) -> Image.Image:
        x, y, w, h = bbox
        slice_arr = orig_img[y:y+h, x:x+w]
        pil = Image.fromarray(slice_arr)
        magnified = pil.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        sharpened = magnified.filter(ImageFilter.UnsharpMask(radius=2.1, percent=300, threshold=3))
        final = ImageEnhance.Contrast(sharpened).enhance(2.5)
        return final

    def process_image(self, image_path: str, mode: str = "columns"):
        print(f"\n Processing: {Path(image_path).name} | Mode: {mode.upper()}")
        base_name = Path(image_path).stem

        img = self.load_image(image_path)
        img, _ = self.correct_orientation(img)
        deskewed, skew_angle = self.deskew(img)
        _, binary = self.enhance_and_binary(deskewed)

        Image.fromarray(deskewed).save(self.output_dir / f"{base_name}_deskewed.png")
        Image.fromarray(binary).save(self.output_dir / f"{base_name}_binary.png")

        page_regions = self.detect_and_split_pages(deskewed)
        print(f"   Detected {len(page_regions)} page region(s)")

        metadata = []
        slice_id = 0

        for p_idx, (rx, ry, rw, rh) in enumerate(page_regions):
            page_img = deskewed[ry:ry+rh, rx:rx+rw]
            page_bin = binary[ry:ry+rh, rx:rx+rw]

            if mode == "fullpage":
                scale = 2.6
                final = self.process_slice(deskewed, (rx, ry, rw, rh), scale)
                final.save(self.output_dir / f"{base_name}_p{p_idx}_full.png")
                continue

            elif mode == "lines":
                strips = self.get_line_strips(page_bin)
                scale = 3.85
                for i, (sx, sy, sw, sh) in enumerate(strips):
                    global_bbox = (rx + sx, ry + sy, sw, sh)
                    final = self.process_slice(deskewed, global_bbox, scale)
                    final.save(self.output_dir / f"{base_name}_p{p_idx}_line_{i:03d}.png")
                    slice_id += 1

            else:  # columns (recommended default)
                columns = self.get_columns(page_bin)
                scale = 3.65 if rw < 1100 else 3.25
                for i, (cx, cy, cw, ch) in enumerate(columns):
                    global_bbox = (rx + cx, ry + cy, cw, ch)
                    final = self.process_slice(deskewed, global_bbox, scale)
                    final.save(self.output_dir / f"{base_name}_p{p_idx}_col_{i:02d}.png")
                    slice_id += 1

        print(f" Completed processing — {slice_id} slices generated\n")


if __name__ == "__main__":
    processor = LegalBookPreOCR(output_dir="preocr_final")

    # Example usage
    images = ["IMG_2120.JPEG", "IMG_2110_L.jpg", "IMG_2040.JPEG", "IMG_2059.JPEG"]

    for img_path in images:
        if Path(img_path).exists():
            processor.process_image(img_path, mode="columns")   # Best default
            # processor.process_image(img_path, mode="lines")
            # processor.process_image(img_path, mode="fullpage")

    print(" All images processed successfully!")
