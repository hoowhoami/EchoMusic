#!/usr/bin/env python3
"""Generate Windows tile icons with proper padding."""

import sys
import os
from PIL import Image
import numpy as np

def clean_transparent_pixels(img):
    """Clean transparent pixels to prevent white halo."""
    data = np.array(img)
    mask = data[:, :, 3] < 255
    data[mask, 0:3] = 0
    return Image.fromarray(data)

def generate_tile_icon(source, output, size, padding_percent=15):
    """Generate a tile icon with padding."""
    img = Image.open(source).convert('RGBA')
    img = clean_transparent_pixels(img)

    # Calculate content size with padding
    content_size = int(size * (1 - padding_percent / 100))
    padding = (size - content_size) // 2

    # Resize content
    resized = img.resize((content_size, content_size), Image.Resampling.LANCZOS)
    resized = clean_transparent_pixels(resized)

    # Create canvas with padding
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(resized, (padding, padding), resized)

    # Save
    canvas.save(output, 'PNG')
    print(f"✓ Generated {output} ({size}x{size} with {padding_percent}% padding)")

def main():
    source_icon = 'assets/icons/icon.png'
    output_dir = 'windows/runner/resources/Assets'

    if not os.path.exists(source_icon):
        print(f"Error: Source icon not found: {source_icon}")
        sys.exit(1)

    # Create Assets directory
    os.makedirs(output_dir, exist_ok=True)

    # Generate tile icons with padding
    # Windows tile sizes
    generate_tile_icon(source_icon, f'{output_dir}/Square150x150Logo.png', 150, 15)
    generate_tile_icon(source_icon, f'{output_dir}/Square70x70Logo.png', 70, 15)
    generate_tile_icon(source_icon, f'{output_dir}/Square44x44Logo.png', 44, 15)

    print("\n✓ All tile icons generated successfully!")

if __name__ == '__main__':
    main()
