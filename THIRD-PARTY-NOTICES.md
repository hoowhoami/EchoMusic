# Third-Party Notices

This project includes software components from third parties. This file lists the copyright holders and license information for these components.

---

## Runtime Dependencies

### mpv

- **Name**: mpv Media Player
- **License**: GNU Lesser General Public License v2.1 or later (LGPL-2.1+) / GNU General Public License v2 or later (GPL-2.0+)
- **Copyright**: Copyright © 2000-2024 mpv/MPlayer/mplayer2 projects
- **Homepage**: https://mpv.io/
- **Description**: Cross-platform media player used as audio playback engine via libmpv
- **Usage**: Dynamically linked at runtime; users are required to install mpv separately

### Electron

- **Name**: Electron
- **License**: MIT License
- **Copyright**: Copyright © 2013-2024 GitHub Inc.
- **Homepage**: https://www.electronjs.org/

### Vue.js

- **Name**: Vue.js
- **License**: MIT License
- **Copyright**: Copyright © 2014-2024 Evan You
- **Homepage**: https://vuejs.org/

### Pinia

- **Name**: Pinia
- **License**: MIT License
- **Copyright**: Copyright © 2020-2024 Eduardo San Martin Morote
- **Homepage**: https://pinia.vuejs.org/

### Reka UI

- **Name**: Reka UI
- **License**: MIT License
- **Copyright**: Copyright © Reka UI contributors
- **Homepage**: https://reka-ui.com/

### Howler.js

- **Name**: Howler.js
- **License**: MIT License
- **Copyright**: Copyright © 2013-2024 James Simpson
- **Homepage**: https://howlerjs.com/

### Marked

- **Name**: Marked
- **License**: MIT License
- **Copyright**: Copyright © 2011-2024 Christopher Jeffrey
- **Homepage**: https://marked.js.org/

### SortableJS

- **Name**: SortableJS
- **License**: MIT License
- **Copyright**: Copyright © 2014-2024 Lebedev Konstantin
- **Homepage**: https://sortablejs.github.io/Sortable/

### Tabler Icons

- **Name**: Tabler Icons
- **License**: MIT License
- **Copyright**: Copyright © 2020-2024 Paweł Kuna
- **Homepage**: https://tabler-icons.io/

---

## Native Addons

### echo-mpv-player

- **Name**: echo-mpv-player
- **License**: MIT License
- **Copyright**: Copyright © 2026 hoowhoami
- **Description**: Rust NAPI addon for libmpv integration
- **Dependencies**: napi, napi-derive, libloading (all MIT licensed)

### echo-media-controls

- **Name**: echo-media-controls
- **License**: MIT License
- **Copyright**: Copyright © 2026 hoowhoami
- **Description**: Rust NAPI addon for native media session integration
- **Dependencies**:
  - Windows: windows-sys (MIT)
  - Linux: mpris-server (MIT), tempfile (MIT)
  - macOS: block2 (MIT), objc2 (MIT)

---

## Server Dependencies (server/)

### Node.js Modules

| Package | License |
|---------|---------|
| axios | MIT |
| express | MIT |
| pako | MIT |
| qrcode | MIT |
| crypto-js | MIT |
| dotenv | BSD-2-Clause |

---

## License Compliance

This project dynamically links to libmpv at runtime. Users must comply with the LGPL-2.1+ license terms when using this software. The LGPL requires that users have the ability to modify and relink against a modified version of libmpv.

Electron includes components from Chromium which are licensed under various open-source licenses. Please refer to Electron's LICENSE file for details.

---

*This file is provided for informational purposes only. Please refer to each component's original license for full terms and conditions.*