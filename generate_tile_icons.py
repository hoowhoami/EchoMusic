#!/usr/bin/env python3
"""Generate Windows tile icons with proper padding according to Microsoft guidelines."""

import sys
import os
from PIL import Image

def generate_tile_icon(source, output, canvas_size, icon_size):
    """Generate a tile icon with transparent padding using Pillow."""
    try:
        # Open source image and ensure RGBA mode
        img = Image.open(source).convert('RGBA')

        # Clean up transparent pixels - set RGB to black for fully transparent areas
        # This prevents white halos on dark backgrounds
        import numpy as np
        data = np.array(img)
        # Where alpha is 0, set RGB to 0 (black) to avoid color bleeding
        mask = data[:, :, 3] == 0
        data[mask] = [0, 0, 0, 0]
        img = Image.fromarray(data, 'RGBA')

        # Resize to icon content size with high-quality resampling
        img = img.resize((icon_size, icon_size), Image.Resampling.LANCZOS)

        # Create transparent canvas (black RGB with 0 alpha)
        canvas = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))

        # Calculate position to center the icon
        padding = (canvas_size - icon_size) // 2

        # Paste icon onto canvas
        canvas.paste(img, (padding, padding), img)

        # Save with transparency
        canvas.save(output, 'PNG', optimize=True)

        print(f"✓ Generated {output} ({canvas_size}x{canvas_size}, content: {icon_size}x{icon_size})")
        return True
    except Exception as e:
        print(f"✗ Failed to generate {output}: {e}")
        return False

def main():
    source_icon = 'assets/icons/icon.png'
    output_dir = 'windows/runner/resources/Assets'

    if not os.path.exists(source_icon):
        print(f"Error: Source icon not found: {source_icon}")
        sys.exit(1)

    # Create output directory if it doesn't exist
    os.makedirs(output_dir, exist_ok=True)

    # Windows tile icon specifications
    # Format: (output_name, canvas_size, icon_content_size)
    specs = [
        ('Square150x150Logo.png', 150, 100),  # 25px padding on each side
        ('Square70x70Logo.png', 70, 48),      # 11px padding on each side
        ('Square44x44Logo.png', 44, 30),      # 7px padding on each side
    ]

    success_count = 0
    for output_name, canvas_size, icon_size in specs:
        output_path = os.path.join(output_dir, output_name)
        if generate_tile_icon(source_icon, output_path, canvas_size, icon_size):
            success_count += 1

    print(f"\n{success_count}/{len(specs)} icons generated successfully.")

    if success_count == len(specs):
        print("\n✓ All tile icons generated with proper padding!")
        print("  The icons now have transparent borders to prevent scaling issues.")
    else:
        print("\n✗ Some icons failed to generate.")
        sys.exit(1)

if __name__ == '__main__':
    main()
