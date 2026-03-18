#!/usr/bin/env python3
"""Generate Windows app_icon.ico with transparent background and multiple sizes."""

import sys
import os
from PIL import Image

def clean_transparent_pixels(img):
    """Clean transparent pixels to prevent white halo."""
    import numpy as np
    data = np.array(img)

    # More aggressive cleaning: set RGB to 0 for any pixel with alpha < 255
    # This removes semi-transparent white edges from anti-aliasing
    mask = data[:, :, 3] < 255
    data[mask, 0:3] = 0  # Set RGB to black, keep alpha

    return Image.fromarray(data, 'RGBA')

def generate_ico(source, output):
    """Generate .ico file with multiple sizes."""
    try:
        # Open and clean source image
        img = Image.open(source).convert('RGBA')
        img = clean_transparent_pixels(img)

        # Windows icon standard sizes (largest first for better quality)
        sizes = [256, 128, 64, 48, 32, 24, 16]
        icons = []

        for size in sizes:
            resized = img.resize((size, size), Image.Resampling.LANCZOS)
            resized = clean_transparent_pixels(resized)
            icons.append(resized)

        # Save as .ico - first image with append_images for the rest
        icons[0].save(
            output,
            format='ICO',
            append_images=icons[1:],
            bitmap_format='png'  # Use PNG format for better quality
        )

        print(f"✓ Generated {output} with sizes: {sizes}")

        # Verify the output
        import subprocess
        result = subprocess.run(['file', output], capture_output=True, text=True)
        print(f"  Verification: {result.stdout.strip()}")

        return True
    except Exception as e:
        print(f"✗ Failed to generate {output}: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    source_icon = 'assets/icons/icon.png'
    output_ico = 'windows/runner/resources/app_icon.ico'

    if not os.path.exists(source_icon):
        print(f"Error: Source icon not found: {source_icon}")
        sys.exit(1)

    if generate_ico(source_icon, output_ico):
        print("\n✓ app_icon.ico generated successfully!")
        print("  The icon now has transparent background for all sizes.")
    else:
        sys.exit(1)

if __name__ == '__main__':
    main()
