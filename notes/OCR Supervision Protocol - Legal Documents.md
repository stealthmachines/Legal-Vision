# OCR Supervision Framework for Legal Document Images

## Current Situation
- **Location**: `C:\Users\Owner\Documents\Josef's Law Collection\11 Am Jur 1d Const Law\iCloud Photos\Rotated`
- **Images**: IMG_1771.JPEG through IMG_2020+.JPEG (500+ images)
- **Existing Scripts**: 
  - `bulk_ocr_transcriber.py` - Basic Tesseract OCR with preprocessing
  - `clean_transcription.py` - Post-process corrections

## Problem Statement
The current tool is "garbling text" and requires **perfect transcription**. Images are rotated, which degrades OCR quality.

## Required Supervision Workflow

### Phase 1: Individual Image Processing & Verification
For each image:
1. Detect and correct rotation (auto-detect orientation)
2. Apply advanced preprocessing for legal documents
3. Extract text with Tesseract using optimal PSM modes
4. **HUMAN REVIEW REQUIRED**: Display transcription for verification
5. Allow corrections if needed
6. Save verified result

### Phase 2: Batch Processing with Logging
1. Process images one at a time (not all at once)
2. Log each transcription attempt and correction
3. Generate quality metrics

## Recommended Enhancements to Achieve "Perfect" Transcription

### A. Rotation Detection & Correction (CRITICAL)
The current scripts don't handle rotated images. Need:
```python
# Detect rotation using text lines or ML
from PIL import Image, ImageEnhance
import numpy as np

def detect_rotation(image):
    """Detect dominant orientation in image"""
    img = np.array(image).astype(np.uint8)
    # Use Hough Line Transform or simple projection profile
    # Return optimal rotation angle (0, 90, 180, 270 degrees)
    pass

def rotate_image(image, angle):
    """Rotate image to correct orientation"""
    h, w = image.size
    matrix = Image.affine((w, h), (-np.sin(np.radians(angle)), np.cos(np.radians(angle))), (h/2, w/2))
    return image.transform((w, h), Image.AFFINE, matrix)
```

### B. Advanced Preprocessing for Legal Text
Current preprocessing is basic. Need:
- Better denoising (NLM with tuned parameters)
- Adaptive thresholding instead of simple OTSU
- De-skewing if text lines are tilted
- Contrast enhancement optimized for grayscale legal documents

### C. Multiple OCR Attempts with Voting
1. Try 4 different PSM modes per image
2. Compare results, pick best confidence score
3. Manual review shows all variants side-by-side

### D. Per-Image Supervision Interface
Create an interactive tool that:
- Processes one image at a time
- Shows original image (rotated and corrected)
- Displays raw OCR text in editable form
- Allows keyboard shortcuts for common corrections
- Saves to organized output files
- Logs all changes made

## Implementation Steps

### Step 1: Create Rotation-Aware Preprocessor
```python
def preprocess_legal_image(image_path):
    """Enhanced preprocessing for legal documents"""
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    
    # 1. Detect and correct rotation
    angle = detect_orientation(img)
    if angle != 0:
        img = rotate_and_deskew(img, angle)
    
    # 2. Advanced denoising
    img = cv2.fastNlMeansDenoising(img, h=7, templateWindowSize=7, searchWindowSize=7)
    
    # 3. Adaptive thresholding (better than OTSU for uneven lighting)
    img = cv2.adaptiveThreshold(
        img, 255, 
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 11, 2
    )
    
    # 4. Contrast enhancement
    img = cv2.convertScaleAbs(img, alpha=1.8, beta=-10)
    
    return img
```

### Step 2: Supervision Script Structure
```python
def supervise_transcription(image_path, output_dir):
    """Process one image with human-in-the-loop verification"""
    
    # Load and preprocess
    img = Image.open(image_path)
    processed = preprocess_legal_image(image_path)
    
    # Detect rotation
    angle = detect_rotation(img)
    if angle != 0:
        print(f"⚠️  Detected {angle}° rotation - correcting...")
        corrected = rotate_image(img, angle)
        
        # Ask user to confirm
        response = input("Apply rotation? (y/n): ")
        if response.lower() != 'y':
            corrected = img
    
    # Extract text with multiple strategies
    results = {
        'psm_3': pytesseract.image_to_string(corrected, config='--psm 3'),
        'psm_6': pytesseract.image_to_string(corrected, config='--psm 6'),
        'psm_11': pytesseract.image_to_string(corrected, config='--psm 11'),
    }
    
    # Show results to user
    print("\n=== OCR RESULTS ===")
    for psm, text in results.items():
        print(f"\n--- PSM {psm} ({len(text)} chars) ---")
        print(text[:500])  # Show first 500 chars
    
    # Let user select and edit
    selected_psm = input("\nWhich result? (3/6/11): ").strip()
    selected_text = results[selected_psm]
    
    final_text = edit_transcription(selected_text)
    
    # Save verified result
    output_path = os.path.join(output_dir, f"{Path(image_path).stem}_verified.txt")
    with open(output_path, 'w') as f:
        f.write(final_text)
    
    return output_path
```

### Step 3: Logging System
Create a database or structured log file tracking:
- Image filename
- Rotation angle detected/corrected
- PSM mode used
- Character count
- Corrections made (if any)
- Timestamp

## Quick Start Commands for Manual Supervision

1. **Test rotation detection on one image:**
   ```python
   from PIL import Image
   img = Image.open('IMG_1771.JPEG')
   # Check if you need to rotate: try 90, 180, 270 degrees and visually verify
   rotated_90 = img.rotate(90, expand=True)
   rotated_180 = img.rotate(180, expand=True)
   rotated_270 = img.rotate(270, expand=True)
   # Save each to compare: save as IMG_1771_r90.png etc.
   ```

2. **Run corrected OCR:**
   ```python
   import pytesseract
   from PIL import Image
   
   # After manually rotating and saving the correct orientation
   img = Image.open('IMG_1771_rotated_correctly.png')
   text = pytesseract.image_to_string(img, config='--psm 6 -c tessedit_page_seg_mode=6')
   print(text)
   ```

## Alternative: Use Commercial OCR Services for Better Accuracy

If perfect transcription is critical and Tesseract isn't sufficient:

1. **Google Cloud Vision API** - Handles rotation automatically, very high accuracy
2. **AWS Textract** - Specialized in document analysis
3. **Azure Computer Vision + Read API** - Good for printed text

Example with Google Cloud Vision (requires API key):
```python
from google.cloud import vision

def transcribe_with_google(image_path):
    client = vision.ImageAnnotatorClient()
    
    with open(image_path, 'rb') as file:
        content = file.read()
    image = vision.Image(content=content)
    
    response = client.text_detection(image=image)
    texts = response.text_annotations
    
    # Returns text blocks sorted by position
    return '\n'.join([block.description for block in response.full_text_annotation.text_blocks])
```

## Next Steps Recommendation

1. **Immediate**: Download one sample image and manually verify what rotation it needs
2. **Short-term**: Create a simple GUI tool (using tkinter or PyQt) that lets you:
   - Load image
   - See 4 rotated versions side-by-side
   - Select correct orientation
   - View OCR result in editable text area
   - Save corrected transcription
3. **Medium-term**: Integrate automatic rotation detection using ML models
4. **Long-term**: Consider commercial API services if volume justifies cost

Would you like me to:
A) Create a complete interactive Python script for manual supervision?
B) Set up an automated batch processor with verification checkpoints?
C) Help configure Google Cloud Vision or similar service for better accuracy?
D) Something else specific to your needs?
