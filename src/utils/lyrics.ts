import { ref, nextTick } from 'vue';
import type { LyricsLine, LyricsCharacter, LyricsMode } from '@/types';
import { searchLyric, getLyric } from '@/api/song';

export class LyricsHandler {
  private lyricsData = ref<LyricsLine[]>([]);
  private originalLyrics = ref<string>('');
  private showLyrics = ref<boolean>(false);
  private scrollAmount = ref<number | null>(null);
  private songTips = ref<string>('暂无歌词');
  private lyricsMode = ref<LyricsMode>('translation');
  private currentLineIndex = 0;
  
  // 桌面歌词相关
  private desktopLyricsWindow: any = null;
  private isDesktopLyricsEnabled = ref<boolean>(false);
  private isElectron = typeof window !== 'undefined' && window.require;
  
  // 桌面歌词状态
  private isLocked = ref<boolean>(false);
  private isPlaying = ref<boolean>(false);
  private fontSize = ref<number>(32);
  private defaultColor = ref<string>('#999999');
  private highlightColor = ref<string>('#409eff');
  private currentTime = ref<number>(0);
  private currentSongHash = '';

  // 获取响应式数据的getter
  get data() {
    return {
      lyricsData: this.lyricsData,
      originalLyrics: this.originalLyrics,
      showLyrics: this.showLyrics,
      scrollAmount: this.scrollAmount,
      songTips: this.songTips,
      lyricsMode: this.lyricsMode,
      isDesktopLyricsEnabled: this.isDesktopLyricsEnabled,
    };
  }

  /**
   * 显示/隐藏歌词
   */
  toggleLyrics(hash?: string, currentTime?: number): boolean {
    this.showLyrics.value = !this.showLyrics.value;
    this.songTips.value = '获取歌词中';
    
    // 如果显示歌词，滚动到当前播放行
    if (!this.lyricsData.value.length && hash) {
      this.getLyrics(hash);
    } else if (this.showLyrics.value && currentTime !== undefined) {
      nextTick(() => {
        const currentLineIndex = this.getCurrentLineIndex(currentTime);
        if (currentLineIndex !== -1) {
          this.scrollToCurrentLine(currentLineIndex);
        } else {
          this.centerFirstLine();
        }
      });
    }
    
    return this.showLyrics.value;
  }

  /**
   * 获取歌词
   */
  async getLyrics(hash: string): Promise<boolean> {
    try {
      const settings = JSON.parse(localStorage.getItem('settings') || '{}');
      if (!this.showLyrics.value && 
          (settings?.desktopLyrics === 'off' && settings?.apiMode === 'off')) {
        return false;
      }

      // 更新当前歌曲哈希
      this.currentSongHash = hash;

      console.log('[LyricsHandler] 请求歌词……');
      const lyricSearchResponse = await searchLyric({ hash });
      
      if (!lyricSearchResponse?.candidates?.length) {
        this.songTips.value = '暂无歌词';
        // 清空桌面歌词显示
        this.clearDesktopLyricsContent();
        return false;
      }

      // 明确指定使用KRC格式
      const candidate = lyricSearchResponse.candidates[0];
      const lyricResponse = await getLyric({
        id: candidate.id,
        accesskey: candidate.accesskey,
        fmt: 'krc',
        decode: 'true',
      });
      
      if (!lyricResponse?.decodeContent) {
        this.songTips.value = '获取歌词失败';
        this.clearDesktopLyricsContent();
        return false;
      }
      
      this.parseLyrics(lyricResponse.decodeContent, settings?.lyricsTranslation === 'on');
      this.originalLyrics.value = lyricResponse.decodeContent;
      this.centerFirstLine();
      
      // 强制更新桌面歌词
      this.forceUpdateDesktopLyrics();
      
      return true;
    } catch (error) {
      console.error('[LyricsHandler] 获取歌词失败:', error);
      this.songTips.value = '获取歌词失败';
      this.clearDesktopLyricsContent();
      return false;
    }
  }

  /**
   * 解析歌词
   */
  private parseLyrics(text: string, parseTranslation = true): void {
    let translationLyrics: string[][] = [];
    let romanizationLyrics: string[][] = [];
    const lines = text.split('\n');
    
    try {
      const languageLine = lines.find(line => line.match(/\[language:(.*)\]/));
      if (parseTranslation && languageLine) {
        const languageCode = languageLine.slice(10, -2);
        if (languageCode) {
          try {
            // 确保 languageCode 是有效的 Base64 编码
            const cleanedCode = languageCode.replace(/[^A-Za-z0-9+/=]/g, '');
            const paddedCode = cleanedCode.padEnd(cleanedCode.length + (4 - cleanedCode.length % 4) % 4, '=');
            const decodedData = decodeURIComponent(atob(paddedCode));
            const languageData = JSON.parse(decodedData);

            // 获取翻译歌词 (type === 1)
            const translation = languageData?.content?.find((section: any) => section.type === 1);
            if (translation?.lyricContent) {
              translationLyrics = translation.lyricContent;
            }
            
            // 获取音译歌词 (type === 0)
            const romanization = languageData?.content?.find((section: any) => section.type === 0);
            if (romanization?.lyricContent) {
              romanizationLyrics = romanization.lyricContent;
            }
          } catch (decodeError) {
            console.warn('[LyricsHandler] Base64 解码失败:', decodeError);
          }
        }
      }
    } catch (decodeError) {
      console.warn('[LyricsHandler] Base64 解码失败:', decodeError);
    }

    const parsedLyrics: LyricsLine[] = [];
    const charRegex = /<(\d+),(\d+),\d+>([^<]+)/g;

    lines.forEach(line => {
      // 匹配主时间标签 [start,duration]
      const lineMatch = line.match(/^\[(\d+),(\d+)\](.*)/);
      if (!lineMatch) return;

      const start = parseInt(lineMatch[1]);
      const lyricContent = lineMatch[3];
      const characters: LyricsCharacter[] = [];
      
      // 解析字符级时间标签 <start,duration,unknown>text
      let charMatch;
      const regex = new RegExp(charRegex.source, charRegex.flags);

      while ((charMatch = regex.exec(lyricContent)) !== null) {
        const text = charMatch[3];
        const charDuration = parseInt(charMatch[2]);
        const charStart = start + parseInt(charMatch[1]);
        
        // 直接使用文本组，不拆分
        characters.push({
          char: text,
          startTime: charStart,
          endTime: charStart + charDuration,
          highlighted: false,
        });
      }

      // 如果没有找到字符级时间标签，使用行级时间标签进行等分
      if (characters.length === 0) {
        const duration = parseInt(lineMatch[2]);
        const lyric = lyricContent.replace(/<.*?>/g, '');
        if (lyric.trim()) {
          for (let index = 0; index < lyric.length; index++) {
            characters.push({
              char: lyric[index],
              startTime: start + (index * duration) / lyric.length,
              endTime: start + ((index + 1) * duration) / lyric.length,
              highlighted: false,
            });
          }
        }
      }

      // 保存有效歌词行
      if (characters.length > 0) {
        parsedLyrics.push({ characters });
      }
    });

    // 添加翻译歌词
    if (translationLyrics.length) {
      parsedLyrics.forEach((line, index) => {
        if (translationLyrics[index] && translationLyrics[index][0]) {
          line.translated = translationLyrics[index][0];
        }
      });
    }

    // 添加音译歌词
    if (romanizationLyrics.length) {
      parsedLyrics.forEach((line, index) => {
        if (romanizationLyrics[index]) {
          // 将音译歌词数组合并为一个字符串
          line.romanized = romanizationLyrics[index].join('');
        }
      });
    }

    this.lyricsData.value = parsedLyrics;
  }

  /**
   * 切换歌词显示模式（翻译/音译）
   */
  toggleLyricsMode(): LyricsMode {
    this.lyricsMode.value = this.lyricsMode.value === 'translation' ? 'romanization' : 'translation';
    return this.lyricsMode.value;
  }

  /**
   * 居中显示第一行歌词
   */
  private centerFirstLine(): void {
    const lyricsContainer = document.getElementById('lyrics-container');
    if (!lyricsContainer) return;
    
    const containerHeight = lyricsContainer.offsetHeight;
    const lyricsElement = document.getElementById('lyrics');
    if (!lyricsElement) return;
    
    const lyricsHeight = lyricsElement.offsetHeight;
    this.scrollAmount.value = (containerHeight - lyricsHeight) / 2;
  }

  /**
   * 滚动到当前歌词行
   */
  scrollToCurrentLine(lineIndex: number): boolean {
    if (this.currentLineIndex === lineIndex) return false;
    
    this.currentLineIndex = lineIndex;
    const lyricsContainer = document.getElementById('lyrics-container');
    if (!lyricsContainer) return false;
    
    const containerHeight = lyricsContainer.offsetHeight;
    const lineElement = document.querySelectorAll('.line-group')[lineIndex] as HTMLElement;
    if (lineElement) {
      const lineHeight = lineElement.offsetHeight;
      this.scrollAmount.value = -lineElement.offsetTop + (containerHeight / 2) - (lineHeight / 2);
      return true;
    }
    return false;
  }

  /**
   * 高亮当前字符
   */
  highlightCurrentChar(currentTime: number, scroll = true): void {
    const currentTimeMs = currentTime * 1000 - 500; // 减少500ms延迟，提前高亮
    this.currentTime.value = currentTimeMs + 500; // 保存实际时间用于桌面歌词计算
    
    this.lyricsData.value.forEach((lineData, lineIndex) => {
      let hasHighlightedChar = false;
      
      lineData.characters.forEach((charData) => {
        // 更精确的时间判断
        if (currentTimeMs >= charData.startTime && currentTimeMs <= charData.endTime) {
          if (!charData.highlighted) {
            charData.highlighted = true;
            hasHighlightedChar = true;
          }
        } else if (currentTimeMs > charData.endTime) {
          // 已经播放过的字符保持高亮
          if (!charData.highlighted) {
            charData.highlighted = true;
          }
        } else {
          // 还未播放的字符取消高亮
          charData.highlighted = false;
        }
      });

      // 处理滚动
      if (scroll && hasHighlightedChar) {
        this.scrollToCurrentLine(lineIndex);
      }
    });
    
    // 更新桌面歌词
    this.updateDesktopLyrics();
  }

  /**
   * 重置歌词高亮状态
   */
  resetLyricsHighlight(currentTime: number): void {
    if (!this.lyricsData.value) return;

    const currentTimeMs = currentTime * 1000;

    this.lyricsData.value.forEach((lineData, lineIndex) => {
      let isCurrentLine = false;
      
      lineData.characters.forEach(charData => {
        // 更精确的时间判断
        if (currentTimeMs >= charData.startTime && currentTimeMs <= charData.endTime) {
          charData.highlighted = true;
          isCurrentLine = true;
        } else if (currentTimeMs > charData.endTime) {
          // 已经播放过的字符保持高亮
          charData.highlighted = true;
        } else {
          // 还未播放的字符取消高亮
          charData.highlighted = false;
        }
      });

      if (isCurrentLine) {
        this.scrollToCurrentLine(lineIndex);
      }
    });
  }

  /**
   * 获取当前播放行索引
   */
  getCurrentLineIndex(currentTime: number): number {
    if (!this.lyricsData.value || this.lyricsData.value.length === 0) return -1;

    const currentTimeMs = currentTime * 1000;
    for (let index = 0; index < this.lyricsData.value.length; index++) {
      const lineData = this.lyricsData.value[index];
      const nextLineData = this.lyricsData.value[index + 1];
      const firstChar = lineData.characters[0];
      const nextFirstChar = nextLineData?.characters[0];

      if (
        firstChar && nextFirstChar &&
        currentTimeMs >= firstChar.startTime &&
        currentTimeMs <= nextFirstChar.startTime
      ) return index + 1;
    }
    return this.lyricsData.value.length - 1;
  }

  /**
   * 获取当前行歌词文本
   */
  getCurrentLineText(currentTime: number): string {
    if (!this.lyricsData.value || this.lyricsData.value.length === 0) return '';

    for (const lineData of this.lyricsData.value) {
      const firstChar = lineData.characters[0];
      const lastChar = lineData.characters[lineData.characters.length - 1];

      if (
        firstChar && lastChar &&
        currentTime * 1000 >= firstChar.startTime &&
        currentTime * 1000 <= lastChar.endTime
      ) {
        return lineData.characters.map((char) => char.char).join('');
      }
    }
    return '';
  }

  /**
   * 清空桌面歌词内容
   */
  private clearDesktopLyricsContent(): void {
    if (!this.isDesktopLyricsEnabled.value) return;

    if (this.isElectron) {
      // 发送清空数据到 Electron
      this.sendLyricsDataToElectron();
    } else if (this.desktopLyricsWindow && !this.desktopLyricsWindow.closed) {
      const wrapper = this.desktopLyricsWindow.document.getElementById('lyricsContentWrapper');
      if (wrapper) {
        wrapper.innerHTML = '<div class="lyrics-content hovering nolyrics">暂无歌词</div>';
      }
    }
  }

  /**
   * 强制更新桌面歌词
   */
  private forceUpdateDesktopLyrics(): void {
    if (!this.isDesktopLyricsEnabled.value) return;

    // 重置当前时间，确保从头开始显示
    this.currentTime.value = 0;
    
    // 重置所有字符高亮状态
    this.lyricsData.value.forEach(line => {
      line.characters.forEach(char => {
        char.highlighted = false;
      });
    });

    // 立即更新显示
    this.updateDesktopLyrics();
  }

  /**
   * 清空歌词数据
   */
  clearLyrics(): void {
    this.lyricsData.value = [];
    this.originalLyrics.value = '';
    this.showLyrics.value = false;
    this.scrollAmount.value = null;
    this.songTips.value = '暂无歌词';
    this.currentLineIndex = 0;
    this.clearDesktopLyricsContent();
  }

  /**
   * 开启桌面歌词
   */
  enableDesktopLyrics(): void {
    if (this.isDesktopLyricsEnabled.value) return;
    
    this.isDesktopLyricsEnabled.value = true;
    
    if (this.isElectron) {
      // 使用 Electron 原生窗口
      this.createElectronLyricsWindow();
    } else {
      // 降级到浏览器窗口
      this.createBrowserLyricsWindow();
    }
  }

  /**
   * 关闭桌面歌词
   */
  disableDesktopLyrics(): void {
    if (!this.isDesktopLyricsEnabled.value) return;
    
    this.isDesktopLyricsEnabled.value = false;
    
    if (this.isElectron) {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.send('close-lyrics-window');
    } else if (this.desktopLyricsWindow) {
      this.desktopLyricsWindow.close();
      this.desktopLyricsWindow = null;
    }
  }

  /**
   * 切换桌面歌词
   */
  toggleDesktopLyrics(): boolean {
    if (this.isDesktopLyricsEnabled.value) {
      this.disableDesktopLyrics();
    } else {
      this.enableDesktopLyrics();
    }
    return this.isDesktopLyricsEnabled.value;
  }

  /**
   * 创建 Electron 原生歌词窗口
   */
  private createElectronLyricsWindow(): void {
    const { ipcRenderer } = window.require('electron');
    
    console.log('[LyricsHandler] 请求创建 Electron 歌词窗口');
    
    // 请求创建歌词窗口
    ipcRenderer.send('create-lyrics-window');
    
    // 监听窗口创建完成事件
    ipcRenderer.once('lyrics-window-created', () => {
      console.log('[LyricsHandler] Electron 歌词窗口已创建');
      
      // 设置 IPC 监听器
      this.setupElectronListeners();
      
      // 发送初始歌词数据
      setTimeout(() => {
        this.sendLyricsDataToElectron();
      }, 500); // 延迟一点确保窗口完全准备好
    });
    
    // 监听窗口关闭事件
    ipcRenderer.on('lyrics-window-closed', () => {
      console.log('[LyricsHandler] Electron 歌词窗口已关闭');
      this.isDesktopLyricsEnabled.value = false;
      this.removeElectronListeners();
    });
  }

  /**
   * 设置 Electron IPC 监听器
   */
  private setupElectronListeners(): void {
    if (!this.isElectron) return;
    
    const { ipcRenderer } = window.require('electron');
    
    // 监听来自歌词窗口的控制事件
    ipcRenderer.on('lyrics-control', (_event: any, action: any) => {
      this.handleLyricsControl(action);
    });
  }

  /**
   * 移除 Electron IPC 监听器
   */
  private removeElectronListeners(): void {
    if (!this.isElectron) return;
    
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.removeAllListeners('lyrics-control');
    ipcRenderer.removeAllListeners('lyrics-window-closed');
  }

  /**
   * 处理歌词控制事件
   */
  private handleLyricsControl(action: any): void {
    switch (action.type) {
      case 'previous-song':
        window.dispatchEvent(new CustomEvent('desktop-lyrics-previous'));
        break;
      case 'next-song':
        window.dispatchEvent(new CustomEvent('desktop-lyrics-next'));
        break;
      case 'toggle-play':
        window.dispatchEvent(new CustomEvent('desktop-lyrics-toggle-play'));
        break;
      case 'font-size-change':
        this.fontSize.value = action.value;
        localStorage.setItem('lyrics-font-size', action.value.toString());
        break;
      case 'color-change':
        if (action.colorType === 'default') {
          this.defaultColor.value = action.value;
          localStorage.setItem('lyrics-default-color', action.value);
        } else {
          this.highlightColor.value = action.value;
          localStorage.setItem('lyrics-highlight-color', action.value);
        }
        break;
      case 'lock-toggle':
        this.isLocked.value = action.value;
        localStorage.setItem('lyrics-lock', action.value.toString());
        break;
    }
  }

  /**
   * 发送歌词数据到 Electron 窗口
   */
  private sendLyricsDataToElectron(): void {
    if (!this.isElectron || !this.isDesktopLyricsEnabled.value) return;
    
    const { ipcRenderer } = window.require('electron');
    
    // 序列化歌词数据，确保所有数据都是可克隆的
    const lyricsData = {
      lyrics: JSON.parse(JSON.stringify(this.lyricsData.value)),
      currentTime: this.currentTime.value,
      songTips: this.songTips.value,
      lyricsMode: this.lyricsMode.value,
      currentSongHash: this.currentSongHash || '',
      settings: {
        fontSize: this.fontSize.value,
        defaultColor: this.defaultColor.value,
        highlightColor: this.highlightColor.value,
        isLocked: this.isLocked.value,
        isPlaying: this.isPlaying.value,
      },
    };
    
    ipcRenderer.send('lyrics-data-update', lyricsData);
  }

  /**
   * 创建浏览器歌词窗口（降级方案）
   */
  private createBrowserLyricsWindow(): void {
    if (this.desktopLyricsWindow && !this.desktopLyricsWindow.closed) {
      this.desktopLyricsWindow.focus();
      return;
    }

    const features = [
      'width=800',
      'height=200',
      'top=100',
      'left=' + (screen.width - 800) / 2,
      'toolbar=no',
      'menubar=no',
      'scrollbars=no',
      'resizable=yes',
      'location=no',
      'directories=no',
      'status=no',
      'titlebar=no',
      'frame=no',
      'chrome=no',
      'alwaysOnTop=yes',
    ].join(',');

    // 创建一个空白页面作为桌面歌词
    this.desktopLyricsWindow = window.open('about:blank', 'DesktopLyrics', features);
    
    if (this.desktopLyricsWindow) {
      // 设置窗口始终在最顶层
      try {
        this.desktopLyricsWindow.focus();
        // 尝试设置窗口属性
        if (this.desktopLyricsWindow.document) {
          this.desktopLyricsWindow.document.title = '';
        }
      } catch (e) {
        console.warn('无法设置窗口属性:', e);
      }
      
      this.setupDesktopLyricsContent();
      
      // 监听窗口关闭事件
      const checkClosed = setInterval(() => {
        if (this.desktopLyricsWindow?.closed) {
          this.isDesktopLyricsEnabled.value = false;
          this.desktopLyricsWindow = null;
          clearInterval(checkClosed);
        }
      }, 1000);
    }
  }

  /**
   * 设置桌面歌词窗口内容
   */
  private setupDesktopLyricsContent(): void {
    if (!this.desktopLyricsWindow) return;

    const doc = this.desktopLyricsWindow.document;
    doc.title = '桌面歌词';
    
    // 设置样式
    doc.head.innerHTML = `
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body, html {
          background-color: rgba(0, 0, 0, 0);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
          overflow: hidden;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          z-index: 999999;
          pointer-events: none;
        }

        .lyrics-text {
          display: inline-block;
          position: relative;
          background-clip: text;
          -webkit-background-clip: text;
          font-weight: bold;
          color: transparent;
          transform: translateZ(0);
          will-change: background-position;
          white-space: pre;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
          letter-spacing: 0.5px;
        }

        .lyrics-container {
          backdrop-filter: blur(10px);
          border-radius: 12px;
          user-select: none;
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          align-items: center;
          cursor: inherit;
          font-weight: bold;
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          height: auto;
          transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
          transform: translateZ(0); 
          margin: 8px;
          padding: 8px 0;
          overflow: hidden;
          z-index: 999999;
          pointer-events: auto;
        }

        .lyrics-container.hovering {
          background-color: rgba(0, 0, 0, 0.4);
          cursor: move;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .lyrics-content-wrapper {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          width: 100%;
          transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
          font-size: 32px;
        }

        .controls-overlay {
          opacity: 0;
          transition: opacity 0.4s cubic-bezier(0.4, 0.0, 0.2, 1);
          margin-bottom: 10px;
          height: 40px;
          position: relative;
          z-index: 10;
          pointer-events: auto;
        }

        .lyrics-container.hovering .controls-overlay {
          opacity: 1;
        }

        .lyrics-container.locked .controls-overlay {
          opacity: 0;
        }

        .lyrics-container.locked .controls-overlay.show-locked-controls {
          opacity: 1;
        }

        .controls-wrapper {
          display: flex;
          gap: 15px;
          justify-content: center;
          background: rgba(30, 30, 30, 0.75);
          padding: 6px 12px;
          border-radius: 20px;
          backdrop-filter: blur(4px);
          transition: all 0.3s ease;
          width: auto;
          min-width: 430px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }

        .controls-wrapper.locked-controls {
          background: rgba(30, 30, 30, 0.75);
          padding: 6px;
          width: auto;
          min-width: auto;
          border-radius: 50%;
        }

        .controls-wrapper button {
          background: rgba(50, 50, 50, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.15) !important;
          color: white;
          cursor: pointer;
          width: 28px !important;
          height: 28px !important;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s cubic-bezier(0.4, 0.0, 0.2, 1);
          transform: scale(1);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        }

        .controls-wrapper button:hover {
          transform: scale(1.1);
          background: rgba(80, 80, 80, 0.8);
          border-color: rgba(255, 255, 255, 0.25) !important;
        }

        .controls-wrapper button:active {
          transform: scale(0.95);
        }

        .controls-wrapper i {
          font-size: 16px;
        }

        .lock-button {
          position: relative;
          z-index: 3;
        }

        .lock-button i {
          font-size: 13px !important;
        }

        .lyrics-line {
          overflow: hidden;
          position: relative;
          filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.5));
          opacity: 1;
          transform: translateY(0);
          will-change: background-position;
        }

        .lyrics-content {
          display: inline-block;
          white-space: nowrap;
          transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
          border-radius: 6px;
          transform: translateX(0);
          background-color: transparent;
        }

        .lyrics-container:not(.locked) .lyrics-content.hovering:hover {
          cursor: move;
        }

        .nolyrics {
          margin-bottom: 30px;
          color: #999;
          font-size: 20px;
          opacity: 0.6;
        }

        .controls-wrapper:not(.locked-controls) {
          cursor: move;
        }

        .font-control {
          opacity: 0.8;
          padding: 0 6px;
          display: flex;
          align-items: center;
          gap: 2px;
          width: auto !important;
          transition: all 0.2s cubic-bezier(0.4, 0.0, 0.2, 1);
          transform: scale(1);
        }

        .font-control:hover {
          opacity: 1;
          transform: scale(1.05);
        }

        .font-control i {
          font-size: 12px;
        }

        .font-control i.fa-font {
          font-size: 14px;
          margin: 0 1px;
        }

        .color-controls {
          display: flex;
          gap: 4px;
          align-items: center;
        }

        .color-button {
          padding: 2px !important;
          width: 24px !important;
          height: 24px !important;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(255, 255, 255, 0.2) !important;
          transition: all 0.2s cubic-bezier(0.4, 0.0, 0.2, 1);
          transform: scale(1);
        }

        .color-button:hover {
          transform: scale(1.1);
          border-color: rgba(255, 255, 255, 0.4) !important;
        }

        .color-preview {
          width: 16px;
          height: 16px;
          border-radius: 4px;
          border: 1px solid rgba(255, 255, 255, 0.3);
          transition: all 0.2s cubic-bezier(0.4, 0.0, 0.2, 1);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        }

        .hidden-color-input {
          position: absolute;
          visibility: hidden;
          width: 0;
          height: 0;
          padding: 0;
          margin: 0;
          border: none;
        }
      </style>
    `;

    // 设置初始内容
    doc.body.innerHTML = `
      <div class="lyrics-container" id="lyricsContainer">
        <div class="controls-overlay" id="controlsOverlay">
          <div class="controls-wrapper" id="controlsWrapper">
            <div class="color-controls">
              <button class="color-button" title="默认颜色" onclick="window.lyricsAPI.openColorPicker('default')">
                <div class="color-preview" id="defaultColorPreview" style="background-color: #999999;"></div>
              </button>
              <button class="color-button" title="高亮颜色" onclick="window.lyricsAPI.openColorPicker('highlight')">
                <div class="color-preview" id="highlightColorPreview" style="background-color: #409eff;"></div>
              </button>
              <input id="defaultColorInput" type="color" value="#999999" class="hidden-color-input" onchange="window.lyricsAPI.handleColorChange(this.value, 'default')">
              <input id="highlightColorInput" type="color" value="#409eff" class="hidden-color-input" onchange="window.lyricsAPI.handleColorChange(this.value, 'highlight')">
            </div>
            <button onclick="window.lyricsAPI.changeFontSize(-2)" class="font-control" title="减小字体">
              <i class="fas fa-minus"></i>
              <i class="fas fa-font"></i>
            </button>
            <button onclick="window.lyricsAPI.previousSong()" title="上一首">
              <i class="fas fa-step-backward"></i>
            </button>
            <button onclick="window.lyricsAPI.togglePlay()" title="播放/暂停" id="playButton">
              <i class="fas fa-play"></i>
            </button>
            <button onclick="window.lyricsAPI.nextSong()" title="下一首">
              <i class="fas fa-step-forward"></i>
            </button>
            <button onclick="window.lyricsAPI.changeFontSize(2)" class="font-control" title="增大字体">
              <i class="fas fa-font"></i>
              <i class="fas fa-plus"></i>
            </button>
            <button onclick="window.lyricsAPI.toggleLock()" class="lock-button" id="lockButton" title="锁定">
              <i class="fas fa-lock-open"></i>
            </button>
            <button onclick="window.lyricsAPI.closeLyrics()" title="关闭歌词">
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>
        <div class="lyrics-content-wrapper" id="lyricsContentWrapper">
          <div class="lyrics-content hovering nolyrics">暂无歌词</div>
        </div>
      </div>
    `;

    // 设置窗口API
    this.setupWindowAPI();
    
    // 让窗口可拖拽
    this.makeWindowDraggable();
  }

  /**
   * 设置窗口API
   */
  private setupWindowAPI(): void {
    if (!this.desktopLyricsWindow) return;

    this.desktopLyricsWindow.lyricsAPI = {
      openColorPicker: (type: 'default' | 'highlight') => {
        const input = this.desktopLyricsWindow.document.getElementById(
          type === 'default' ? 'defaultColorInput' : 'highlightColorInput',
        );
        if (input) input.click();
      },

      handleColorChange: (color: string, type: 'default' | 'highlight') => {
        if (type === 'default') {
          this.defaultColor.value = color;
          localStorage.setItem('lyrics-default-color', color);
          const preview = this.desktopLyricsWindow.document.getElementById('defaultColorPreview');
          if (preview) preview.style.backgroundColor = color;
        } else {
          this.highlightColor.value = color;
          localStorage.setItem('lyrics-highlight-color', color);
          const preview = this.desktopLyricsWindow.document.getElementById('highlightColorPreview');
          if (preview) preview.style.backgroundColor = color;
        }
        this.updateDesktopLyrics();
      },

      changeFontSize: (delta: number) => {
        this.fontSize.value = Math.max(12, Math.min(72, this.fontSize.value + delta));
        localStorage.setItem('lyrics-font-size', this.fontSize.value.toString());
        const wrapper = this.desktopLyricsWindow.document.getElementById('lyricsContentWrapper');
        if (wrapper) wrapper.style.fontSize = `${this.fontSize.value}px`;
      },

      previousSong: () => {
        // 触发上一首歌曲事件
        window.dispatchEvent(new CustomEvent('desktop-lyrics-previous'));
      },

      nextSong: () => {
        // 触发下一首歌曲事件
        window.dispatchEvent(new CustomEvent('desktop-lyrics-next'));
      },

      togglePlay: () => {
        this.isPlaying.value = !this.isPlaying.value;
        const button = this.desktopLyricsWindow.document.getElementById('playButton');
        if (button) {
          const icon = button.querySelector('i');
          if (icon) {
            icon.className = this.isPlaying.value ? 'fas fa-pause' : 'fas fa-play';
          }
        }
        // 触发播放/暂停事件
        window.dispatchEvent(new CustomEvent('desktop-lyrics-toggle-play'));
      },

      toggleLock: () => {
        this.isLocked.value = !this.isLocked.value;
        localStorage.setItem('lyrics-lock', this.isLocked.value.toString());
        
        const container = this.desktopLyricsWindow.document.getElementById('lyricsContainer');
        const wrapper = this.desktopLyricsWindow.document.getElementById('controlsWrapper');
        const button = this.desktopLyricsWindow.document.getElementById('lockButton');
        
        if (container && wrapper && button) {
          const icon = button.querySelector('i');
          if (this.isLocked.value) {
            container.classList.add('locked');
            wrapper.classList.add('locked-controls');
            if (icon) icon.className = 'fas fa-lock';
            button.title = '解锁';
          } else {
            container.classList.remove('locked');
            wrapper.classList.remove('locked-controls');
            if (icon) icon.className = 'fas fa-lock-open';
            button.title = '锁定';
          }
        }
      },

      closeLyrics: () => {
        this.disableDesktopLyrics();
      },
    };

    // 加载保存的设置
    this.loadDesktopLyricsSettings();
  }

  /**
   * 加载桌面歌词设置
   */
  private loadDesktopLyricsSettings(): void {
    // 加载保存的设置
    this.isLocked.value = localStorage.getItem('lyrics-lock') === 'true';
    this.fontSize.value = parseInt(localStorage.getItem('lyrics-font-size') || '32');
    this.defaultColor.value = localStorage.getItem('lyrics-default-color') || '#999999';
    this.highlightColor.value = localStorage.getItem('lyrics-highlight-color') || '#409eff';

    // 应用设置到界面
    if (this.desktopLyricsWindow) {
      const wrapper = this.desktopLyricsWindow.document.getElementById('lyricsContentWrapper');
      if (wrapper) wrapper.style.fontSize = `${this.fontSize.value}px`;

      const defaultPreview = this.desktopLyricsWindow.document.getElementById('defaultColorPreview');
      if (defaultPreview) defaultPreview.style.backgroundColor = this.defaultColor.value;

      const highlightPreview = this.desktopLyricsWindow.document.getElementById('highlightColorPreview');
      if (highlightPreview) highlightPreview.style.backgroundColor = this.highlightColor.value;

      const defaultInput = this.desktopLyricsWindow.document.getElementById('defaultColorInput');
      if (defaultInput) (defaultInput as HTMLInputElement).value = this.defaultColor.value;

      const highlightInput = this.desktopLyricsWindow.document.getElementById('highlightColorInput');
      if (highlightInput) (highlightInput as HTMLInputElement).value = this.highlightColor.value;
    }
  }

  /**
   * 让桌面歌词窗口可拖拽
   */
  private makeWindowDraggable(): void {
    if (!this.desktopLyricsWindow) return;

    const doc = this.desktopLyricsWindow.document;
    let isDragging = false;
    let isHovering = false;
    let startX = 0;
    let startY = 0;

    const checkMousePosition = (event: MouseEvent) => {
      const container = doc.getElementById('lyricsContainer');
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const isMouseInContainer = (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );

      const isMouseOnLyrics = event.target && (event.target as HTMLElement).closest('.lyrics-content') !== null;
      const isMouseInControls = event.target && (event.target as HTMLElement).closest('.controls-overlay') !== null;

      if ((isMouseOnLyrics || isMouseInControls) && !this.isLocked.value) {
        isHovering = true;
        container.classList.add('hovering');
      }

      if (!isMouseInContainer && !this.isLocked.value) {
        isHovering = false;
        container.classList.remove('hovering');
      }

      // 锁定状态下的特殊处理
      if (this.isLocked.value) {
        const controlsOverlay = doc.getElementById('controlsOverlay');
        if (isMouseInControls && controlsOverlay) {
          controlsOverlay.classList.add('show-locked-controls');
        } else if (controlsOverlay) {
          controlsOverlay.classList.remove('show-locked-controls');
        }
      }
    };

    const startDrag = (event: MouseEvent) => {
      if (this.isLocked.value) return;

      if (isHovering) {
        isDragging = true;
        startX = event.screenX - this.desktopLyricsWindow!.screenX;
        startY = event.screenY - this.desktopLyricsWindow!.screenY;
        event.preventDefault();
      }
    };

    const onDrag = (event: MouseEvent) => {
      if (!isDragging || !this.desktopLyricsWindow) return;

      this.desktopLyricsWindow.moveTo(
        event.screenX - startX,
        event.screenY - startY,
      );
    };

    const endDrag = () => {
      isDragging = false;
    };

    doc.addEventListener('mousemove', checkMousePosition);
    doc.addEventListener('mousedown', startDrag);
    doc.addEventListener('mousemove', onDrag);
    doc.addEventListener('mouseup', endDrag);
    doc.addEventListener('mouseleave', endDrag);
  }

  /**
   * 更新桌面歌词显示
   */
  private updateDesktopLyrics(): void {
    if (!this.isDesktopLyricsEnabled.value) return;

    if (this.isElectron) {
      // 使用 Electron IPC 发送数据
      this.sendLyricsDataToElectron();
    } else {
      // 使用浏览器窗口方式
      this.updateBrowserLyrics();
    }
  }

  /**
   * 更新浏览器歌词显示
   */
  private updateBrowserLyrics(): void {
    if (!this.desktopLyricsWindow || this.desktopLyricsWindow.closed) {
      return;
    }

    const wrapper = this.desktopLyricsWindow.document.getElementById('lyricsContentWrapper');
    
    if (wrapper) {
      if (this.lyricsData.value.length > 0) {
        // 获取当前显示的歌词行
        const displayedLines = this.getDisplayedLines();
        let content = '';

        displayedLines.forEach((lineData, index) => {
          if (lineData) {
            const isCurrentLine = index === 0; // 第一行是当前行
            const lineStyle = this.getLineHighlightStyle(lineData, isCurrentLine);
            
            content += `
              <div class="lyrics-line">
                <div class="lyrics-content ${isCurrentLine ? 'current' : ''}" 
                     style="${lineStyle}">
                  <span class="lyrics-text">${this.formatLyricsLineText(lineData)}</span>
                </div>
              </div>
            `;

            // 添加翻译歌词
            if (lineData.translated && this.lyricsMode.value === 'translation') {
              content += `
                <div class="lyrics-line">
                  <div class="lyrics-content" style="color: ${this.defaultColor.value};">
                    <span>${lineData.translated}</span>
                  </div>
                </div>
              `;
            }
          }
        });

        wrapper.innerHTML = content;
      } else {
        wrapper.innerHTML = '<div class="lyrics-content hovering nolyrics">暂无歌词</div>';
      }
    }
  }

  /**
   * 获取显示的歌词行
   */
  private getDisplayedLines(): (LyricsLine | null)[] {
    if (!this.lyricsData.value.length) return [];
    
    const currentLineIndex = this.getCurrentLineIndex(this.currentTime.value / 1000);
    const lines: (LyricsLine | null)[] = [];
    
    // 当前行
    if (this.lyricsData.value[currentLineIndex]) {
      lines.push(this.lyricsData.value[currentLineIndex]);
      
      // 如果当前行有翻译，只显示当前行
      if (this.lyricsData.value[currentLineIndex].translated) {
        return lines;
      }
      
      // 否则显示下一行
      if (this.lyricsData.value[currentLineIndex + 1]) {
        lines.push(this.lyricsData.value[currentLineIndex + 1]);
      }
    }
    
    return lines;
  }

  /**
   * 获取行高亮样式（渐变效果）
   */
  private getLineHighlightStyle(line: LyricsLine, isCurrent: boolean): string {
    if (!line.characters || !line.characters.length || !isCurrent) {
      return `color: ${this.defaultColor.value};`;
    }
    
    const characters = line.characters;
    const currentTimeMs = this.currentTime.value - 500; // 减少延迟匹配实际高亮时间
    
    // 获取整行的时间范围
    const lineStartTime = characters[0].startTime;
    const lineEndTime = characters[characters.length - 1].endTime;
    
    // 如果当前时间还没到这一行，不高亮
    if (currentTimeMs < lineStartTime) {
      return `color: ${this.defaultColor.value};`;
    }
    
    // 如果当前时间已经超过这一行的结束时间，完全高亮
    if (currentTimeMs >= lineEndTime) {
      return `
        background: linear-gradient(to right, ${this.highlightColor.value} 0%, ${this.highlightColor.value} 100%);
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        font-weight: bold;
      `;
    }
    
    // 计算基于字符时间的高亮位置
    let highlightPosition = 0;
    const totalText = line.characters.map(c => c.char).join('');
    
    for (let i = 0; i < characters.length; i++) {
      const char = characters[i];
      if (currentTimeMs >= char.startTime && currentTimeMs <= char.endTime) {
        const progress = (currentTimeMs - char.startTime) / (char.endTime - char.startTime);
        const charPosition = totalText.substring(0, i).length;
        const charLength = char.char.length;
        highlightPosition = ((charPosition + progress * charLength) / totalText.length) * 100;
        break;
      }
      if (currentTimeMs > char.endTime) {
        const charEndPosition = totalText.substring(0, i + 1).length;
        highlightPosition = (charEndPosition / totalText.length) * 100;
      }
    }
    
    // 确保高亮位置在合理范围内
    highlightPosition = Math.max(0, Math.min(100, highlightPosition));
    
    return `
      background: linear-gradient(to right, ${this.highlightColor.value} ${highlightPosition}%, ${this.defaultColor.value} ${highlightPosition}%);
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
      font-weight: bold;
    `;
  }

  /**
   * 格式化歌词行文本
   */
  private formatLyricsLineText(line: LyricsLine): string {
    if (!line.characters || !line.characters.length) return '';
    return line.characters.map(char => char.char).join('');
  }

  /**
   * 获取当前活跃的歌词行
   */
  getCurrentActiveLine(): LyricsLine | null {
    if (!this.lyricsData.value.length) return null;
    
    for (const line of this.lyricsData.value) {
      const hasHighlightedChar = line.characters.some(char => char.highlighted);
      if (hasHighlightedChar) {
        return line;
      }
    }
    
    return null;
  }

}

// 创建全局单例实例
export const lyricsHandler = new LyricsHandler();