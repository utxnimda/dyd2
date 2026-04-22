#!/usr/bin/env python3
"""
Music Detector — Detect music (singing) vs speech segments in audio files.

Uses librosa to extract audio features and classify segments as music or speech
based on spectral characteristics. Music segments typically have:
- Higher spectral flatness (more tonal content)
- More stable spectral centroid (consistent pitch)
- Lower zero-crossing rate variance (less noisy than speech)
- Higher RMS energy consistency

Usage:
    python music_detector.py <audio_file> [--min-duration 15] [--hop 5] [--window 10]

Output: JSON to stdout with detected music segments.
"""

import sys
import json
import argparse
import warnings
import os
import subprocess
import tempfile
import numpy as np

warnings.filterwarnings("ignore")

import librosa


def log(msg):
    """Print progress to stderr so stdout stays clean for JSON output."""
    print(f"[music_detector] {msg}", file=sys.stderr, flush=True)


def extract_frame_features(y, sr, frame_length_sec=2.0, hop_length_sec=0.5):
    """
    Extract audio features for each analysis frame.
    Returns a dict of feature arrays, each of length N_frames.
    """
    frame_length = int(frame_length_sec * sr)
    hop_length = int(hop_length_sec * sr)

    n_frames = 1 + max(0, (len(y) - frame_length) // hop_length)
    if n_frames == 0:
        return None

    features = {
        "rms": np.zeros(n_frames),
        "zcr": np.zeros(n_frames),
        "spectral_centroid": np.zeros(n_frames),
        "spectral_rolloff": np.zeros(n_frames),
        "spectral_flatness": np.zeros(n_frames),
        "spectral_bandwidth": np.zeros(n_frames),
        "mfcc_var": np.zeros(n_frames),
        "onset_strength": np.zeros(n_frames),
    }

    for i in range(n_frames):
        start = i * hop_length
        end = start + frame_length
        frame = y[start:end]

        if len(frame) < sr * 0.5:
            continue

        # RMS energy
        rms = np.sqrt(np.mean(frame ** 2))
        features["rms"][i] = rms

        # Zero crossing rate
        zcr = np.mean(librosa.feature.zero_crossing_rate(y=frame, frame_length=2048, hop_length=512)[0])
        features["zcr"][i] = zcr

        # Spectral centroid
        sc = np.mean(librosa.feature.spectral_centroid(y=frame, sr=sr, n_fft=2048, hop_length=512)[0])
        features["spectral_centroid"][i] = sc

        # Spectral rolloff
        sr_off = np.mean(librosa.feature.spectral_rolloff(y=frame, sr=sr, n_fft=2048, hop_length=512)[0])
        features["spectral_rolloff"][i] = sr_off

        # Spectral flatness — key indicator: music is more tonal (lower flatness)
        # but singing with accompaniment has moderate flatness
        sf = np.mean(librosa.feature.spectral_flatness(y=frame, n_fft=2048, hop_length=512)[0])
        features["spectral_flatness"][i] = sf

        # Spectral bandwidth
        sb = np.mean(librosa.feature.spectral_bandwidth(y=frame, sr=sr, n_fft=2048, hop_length=512)[0])
        features["spectral_bandwidth"][i] = sb

        # MFCC variance — speech has higher MFCC variance (more phoneme changes)
        mfcc = librosa.feature.mfcc(y=frame, sr=sr, n_mfcc=13, n_fft=2048, hop_length=512)
        features["mfcc_var"][i] = np.mean(np.var(mfcc, axis=1))

        # Onset strength — music typically has more rhythmic onsets
        onset_env = librosa.onset.onset_strength(y=frame, sr=sr, hop_length=512)
        features["onset_strength"][i] = np.mean(onset_env)

    return features


def classify_frames(features, n_frames):
    """
    Classify each frame as music (True) or speech/other (False).

    Music characteristics vs Speech:
    - Music: more stable spectral centroid, moderate-high energy, rhythmic onsets
    - Speech: higher ZCR variance, higher MFCC variance, less rhythmic
    - Silence/noise: very low RMS
    """
    is_music = np.zeros(n_frames, dtype=bool)

    rms = features["rms"]
    zcr = features["zcr"]
    sc = features["spectral_centroid"]
    sf = features["spectral_flatness"]
    sb = features["spectral_bandwidth"]
    mfcc_var = features["mfcc_var"]
    onset = features["onset_strength"]

    # Normalize features to [0, 1] for easier thresholding
    def norm(arr):
        mn, mx = arr.min(), arr.max()
        if mx - mn < 1e-10:
            return np.zeros_like(arr)
        return (arr - mn) / (mx - mn)

    rms_n = norm(rms)
    zcr_n = norm(zcr)
    sf_n = norm(sf)
    mfcc_var_n = norm(mfcc_var)
    onset_n = norm(onset)
    sb_n = norm(sb)

    # Compute a "music score" for each frame
    # Higher score = more likely to be music
    music_score = np.zeros(n_frames)

    for i in range(n_frames):
        score = 0.0

        # Skip very quiet frames (silence)
        if rms_n[i] < 0.05:
            music_score[i] = -1.0
            continue

        # Music tends to have moderate-to-high energy
        if rms_n[i] > 0.15:
            score += 0.15

        # Music has lower ZCR than speech (speech has many fricatives)
        if zcr_n[i] < 0.5:
            score += 0.2
        elif zcr_n[i] > 0.7:
            score -= 0.15

        # Music has lower spectral flatness (more tonal/harmonic)
        if sf_n[i] < 0.4:
            score += 0.25
        elif sf_n[i] > 0.7:
            score -= 0.2

        # Speech has higher MFCC variance (rapid phoneme changes)
        if mfcc_var_n[i] < 0.4:
            score += 0.2
        elif mfcc_var_n[i] > 0.6:
            score -= 0.15

        # Music has stronger rhythmic onsets
        if onset_n[i] > 0.3:
            score += 0.15

        # Music tends to have wider spectral bandwidth
        if sb_n[i] > 0.4:
            score += 0.1

        music_score[i] = score

    # Apply smoothing — music segments are usually continuous
    kernel_size = 5
    if n_frames >= kernel_size:
        kernel = np.ones(kernel_size) / kernel_size
        music_score_smooth = np.convolve(music_score, kernel, mode="same")
    else:
        music_score_smooth = music_score

    # Threshold: classify as music if score > threshold
    # Use a higher threshold to avoid false positives (speech mistaken as music)
    threshold = 0.18
    is_music = music_score_smooth > threshold

    return is_music, music_score_smooth


def frames_to_segments(is_music, hop_length_sec, frame_length_sec, total_duration, min_duration=15.0, scores=None):
    """
    Convert frame-level boolean labels to time segments.
    Merge adjacent music frames and filter by minimum duration.
    """
    segments = []
    n = len(is_music)
    i = 0

    while i < n:
        if is_music[i]:
            start_frame = i
            while i < n and is_music[i]:
                i += 1
            end_frame = i - 1

            start_time = start_frame * hop_length_sec
            end_time = min(end_frame * hop_length_sec + frame_length_sec, total_duration)
            duration = end_time - start_time

            if duration >= min_duration:
                # Calculate average confidence score for this segment
                avg_confidence = 0.0
                if scores is not None:
                    seg_scores = scores[start_frame:end_frame + 1]
                    avg_confidence = float(np.mean(seg_scores)) if len(seg_scores) > 0 else 0.0
                segments.append({
                    "start": round(start_time, 2),
                    "end": round(end_time, 2),
                    "duration": round(duration, 2),
                    "confidence": round(avg_confidence, 3),
                })
        else:
            i += 1

    # Merge segments that are very close together (gap < 3 seconds)
    merged = []
    for seg in segments:
        if merged and (seg["start"] - merged[-1]["end"]) < 3.0:
            merged[-1]["end"] = seg["end"]
            merged[-1]["duration"] = round(merged[-1]["end"] - merged[-1]["start"], 2)
            # Keep the higher confidence
            merged[-1]["confidence"] = max(merged[-1].get("confidence", 0), seg.get("confidence", 0))
        else:
            merged.append(seg)

    # Re-filter by min_duration after merging
    merged = [s for s in merged if s["duration"] >= min_duration]

    return merged


def ensure_wav(audio_path):
    """
    Convert audio to WAV using ffmpeg for faster/more reliable loading.
    Returns (wav_path, is_temp). Caller should delete temp file when done.
    """
    if audio_path.lower().endswith(".wav"):
        return audio_path, False

    log(f"Converting to WAV for faster processing...")
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", audio_path, "-ac", "1", "-ar", "22050", "-sample_fmt", "s16", tmp.name],
            capture_output=True, timeout=300,
        )
        return tmp.name, True
    except Exception as e:
        # Fallback: let librosa handle it directly
        log(f"ffmpeg conversion failed ({e}), loading directly...")
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)
        return audio_path, False


def detect_music(audio_path, min_duration=15.0, hop_sec=1.0, window_sec=3.0):
    """
    Main entry: detect music segments in an audio file.
    """
    # Convert to WAV first for faster loading
    wav_path, is_temp = ensure_wav(audio_path)

    try:
        log(f"Loading audio: {os.path.basename(audio_path)}")
        y, sr = librosa.load(wav_path, sr=22050, mono=True)
        total_duration = len(y) / sr
        log(f"Loaded {total_duration:.1f}s of audio")
    finally:
        if is_temp and os.path.exists(wav_path):
            os.unlink(wav_path)

    if total_duration < 5:
        return {"segments": [], "totalDuration": round(total_duration, 2), "message": "Audio too short"}

    # Extract features
    log(f"Extracting features (window={window_sec}s, hop={hop_sec}s)...")
    features = extract_frame_features(y, sr, frame_length_sec=window_sec, hop_length_sec=hop_sec)
    if features is None:
        return {"segments": [], "totalDuration": round(total_duration, 2), "message": "Could not extract features"}

    n_frames = len(features["rms"])
    log(f"Extracted features for {n_frames} frames")

    # Classify frames
    log("Classifying frames (music vs speech)...")
    is_music, scores = classify_frames(features, n_frames)
    log(f"Classification done: {int(np.sum(is_music))} music frames, {n_frames - int(np.sum(is_music))} speech/other frames")

    # Convert to time segments
    segments = frames_to_segments(is_music, hop_sec, window_sec, total_duration, min_duration, scores=scores)
    log(f"Found {len(segments)} music segments (min_duration={min_duration}s)")

    # Filter out low-confidence segments (likely not real songs)
    if segments:
        confidences = [s.get("confidence", 0) for s in segments]
        avg_conf = np.mean(confidences) if confidences else 0
        # Keep only segments with confidence above 60% of the average, and at least 0.12
        min_conf = max(0.12, avg_conf * 0.6)
        before_count = len(segments)
        segments = [s for s in segments if s.get("confidence", 0) >= min_conf]
        if len(segments) < before_count:
            log(f"Filtered out {before_count - len(segments)} low-confidence segments (min_conf={min_conf:.3f})")

    return {
        "segments": segments,
        "totalDuration": round(total_duration, 2),
        "nFrames": n_frames,
        "musicFrames": int(np.sum(is_music)),
        "speechFrames": int(n_frames - np.sum(is_music)),
    }


def main():
    parser = argparse.ArgumentParser(description="Detect music segments in audio files")
    parser.add_argument("audio_file", help="Path to the audio file")
    parser.add_argument("--min-duration", type=float, default=15.0,
                        help="Minimum segment duration in seconds (default: 15)")
    parser.add_argument("--hop", type=float, default=1.0,
                        help="Hop length between analysis frames in seconds (default: 1.0)")
    parser.add_argument("--window", type=float, default=3.0,
                        help="Analysis window length in seconds (default: 3.0)")

    args = parser.parse_args()

    try:
        log(f"Processing: {args.audio_file}")
        result = detect_music(
            args.audio_file,
            min_duration=args.min_duration,
            hop_sec=args.hop,
            window_sec=args.window,
        )
        log("Done!")
        # JSON result goes to stdout only
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        log(f"Error: {e}")
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
