# OCR SUPERVISION PROTOCOL - LEGAL DOCUMENTS (STANDARDIZED)

## PRE-PROCESSING STEPS:
1. Initialize ERL context: `erl_context_init(force=true)`
2. Load legal domain expertise: Load "Legal_Domain_Expertise_11AmJur" note
3. Load cross-reference system: Load "Cross_Reference_Verification_System" note
4. Archive old context: `erl_prune(branch="session_context", max_age_days=7)`

## IMAGE PROCESSING WORKFLOW:

### Step 1: Image Enhancement
```bash
magick "PATH\IMG_XXXX.JPEG" -resize 800%x800% -filter Lanczos "PATH\IMG_XXXX_MAGNIFIED.jpg"
```

### Step 2: OCR with Magnified Image
```bash
"C:\Program Files\Tesseract-OCR\tesseract.exe" "PATH\IMG_XXXX_MAGNIFIED.jpg" "PATH\IMG_XXXX_RAW" -l eng -c tessedit_char_whitelist="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?()-@[]$%&*+=<>?/|"
```

### Step 3: Quality Check
- If error "Image too small to scale", try: `-resize 300%x300%`
- If still poor quality, try `-resize 400%x400%`

### Step 4: Context-Aware Transcription
- Apply legal syntax knowledge
- Fix OCR errors using section numbering patterns
- Preserve left/right page markers
- Maintain cross-reference format (supra, infra, see, etc.)
- Verify section number sequences

### Step 5: Save Transcriptions
1. **Perfected text:** `PATH\IMG_XXXX_PERFECTED.txt`
2. **Update progress:** Append to `transcription_progress2.json`

### Step 6: Update Progress Tracker
```json
{
  "IMG_XXXX.JPEG": {
    "date": "2025:11:24",
    "pages": "[Page description]",
    "text": "[Transcribed content]",
    "status": "completed",
    "confidence": "XX%",
    "method_used": "Windows Magnifier (8x) + Tesseract OCR + Legal Context Enhancement",
    "notes": "[Key discoveries and cross-references]"
  }
}
```

## CROSS-REFERENCE VERIFICATION:
- ✅ Check all section references exist in transcription
- ✅ Verify "supra" references point to earlier sections
- ✅ Verify "infra" references point to later sections
- ✅ Ensure section numbers are sequential and logical
- ✅ Flag any missing or out-of-sequence sections

## CONFLICT RESOLUTION:
- If OCR is garbled, use context from related transcriptions
- If section number conflicts, check forward/backward progressions
- If cross-reference doesn't exist, verify OCR or flag for review

## QUALITY STANDARDS:
- 95%+ confidence for clear text
- 90%+ confidence for index pages
- 85%+ confidence for dense legal text
- All transcriptions must have:
  - Correct section numbering (§ XX)
  - Proper cross-reference syntax
  - Left/right page markers when applicable
  - Consistent formatting

## POST-PROCESSING:
1. Update `transcription_progress2.json` with completed images
2. Create summary note of key discoveries
3. Archive old ERL entries if context is large
4. Document any anomalies or special formatting

## SESSION RESUME PROCEDURE:
If session is lost/restarted:
1. Call `get_context()` to load current state
2. Load "OCR_SUPERVISION_PROTOCOL_LEGAL_DOCUMENTS" note
3. Load "Legal_Domain_Expertise_11AmJur" note  
4. Load "Cross_Reference_Verification_System" note
5. Load "transcription_progress2_summary" note
6. Resume from last incomplete image
7. Continue workflow from Step 1
