# Traditional character variants

Source: [BYVoid/OpenCC](https://github.com/BYVoid/OpenCC/tree/8cf737a4e193db27d675b2ce9867d84aace33745/data/dictionary), revision `8cf737a4e193db27d675b2ce9867d84aace33745`.

- `TWVariantsRev.txt` is generated from upstream `TWVariants.txt` using the ordering and `@reverse-prefer` rules in upstream `data/scripts/common.py:reverse_items` (called by `reverse.py`).
- `TWVariantsRevPhrases.txt` is copied unchanged from that revision. Phrase exceptions preserve distinctions such as 才華, 著作 and the surname 梁 while converting 橋梁 to 橋樑.

These dictionaries are licensed under Apache-2.0; see [the bundled license](../../../LICENSES/OpenCC-Apache-2.0.txt). Changes: generated reverse dictionary adds source/license comments; phrase dictionary is unchanged.

The app-specific `s2t-variants` profile first performs the existing `s2t` conversion, then applies OpenCC reverse variant conversion with these dictionaries. Only the reverse-variant slots are replaced; the existing four profiles keep their original dictionaries and behavior. Both stages run in the same native worker and share one converter. Dictionary targets preserve Unicode scalar counts, so timed lyric segments and ruby remain aligned.
