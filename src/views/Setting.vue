<template>
  <div class="setting-page">
    <div class="setting-header">
      <NText
        tag="h1"
        :depth="1"
        class="header-title"
      >
        偏好设置
      </NText>
      <NText
        :depth="3"
        class="header-desc"
        >个性化您的音乐播放体验</NText
      >
    </div>

    <div class="setting-content">
      <!-- 外观设置 -->
      <NCard
        class="setting-group"
        title="外观设置"
        size="small"
      >
        <template #header-extra>
          <NIcon
            :size="20"
            :color="themeVars.primaryColor"
          >
            <Palette />
          </NIcon>
        </template>

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              主题模式
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              选择您喜欢的主题外观
            </NText>
          </div>
          <NSelect
            size="small"
            v-model:value="settingStore.theme"
            :options="themeOptions"
            style="width: 120px"
            @update:value="switchTheme"
          />
        </div>

        <NDivider />

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              显示播放列表数量
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              在播放列表图标上显示歌曲数量
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.showPlaylistCount" />
        </div>
      </NCard>

      <!-- 播放设置 -->
      <NCard
        class="setting-group"
        title="播放设置"
        size="small"
      >
        <template #header-extra>
          <NIcon
            :size="20"
            :color="themeVars.primaryColor"
          >
            <PlayerPlay />
          </NIcon>
        </template>

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              歌曲列表添加到播放列表
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              播放歌曲时将整个歌曲列表添加到本地播放列表
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.addSongsToPlaylist" />
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              替换本地播放列表
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              歌单/专辑等在点击播放全部歌曲时用当前的歌曲列表替换本地播放列表
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.replacePlaylist" />
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              音量淡入淡出
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              播放和暂停时启用音量渐变效果
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.volumeFade" />
        </div>

        <NDivider />

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              淡入淡出时间
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              音量渐变效果的持续时间
            </NText>
          </div>
          <div class="setting-control">
            <NSlider
              v-model:value="settingStore.volumeFadeTime"
              :min="100"
              :max="3000"
              :step="100"
              style="width: 200px"
              :tooltip="false"
              :disabled="!settingStore.volumeFade"
            />
            <NText
              :depth="2"
              class="fade-time-text"
            >
              {{ (settingStore.volumeFadeTime / 1000).toFixed(1) }}s
            </NText>
          </div>
        </div>

        <NDivider />

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              播放错误时自动下一首
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              歌曲无法播放时自动跳到下一首
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.autoNextOnError" />
        </div>

        <NDivider />

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              自动跳转延迟
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              播放错误后等待多长时间跳转
            </NText>
          </div>
          <div class="setting-control">
            <NSlider
              v-model:value="settingStore.autoNextOnErrorTime"
              :min="1000"
              :max="10000"
              :step="500"
              style="width: 200px"
              :tooltip="false"
              :disabled="!settingStore.autoNextOnError"
            />
            <NText
              :depth="2"
              class="fade-time-text"
            >
              {{ (settingStore.autoNextOnErrorTime / 1000).toFixed(1) }}s
            </NText>
          </div>
        </div>

        <NDivider />

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              播放时防止系统休眠
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              播放音乐时阻止系统进入休眠状态
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.preventSleep" />
        </div>
      </NCard>

      <!-- 音质设置 -->
      <NCard
        class="setting-group"
        title="音质设置"
        size="small"
      >
        <template #header-extra>
          <NIcon
            :size="20"
            :color="themeVars.primaryColor"
          >
            <DeviceAudioTape />
          </NIcon>
        </template>

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              兼容模式
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              当首选音质无法获取时，自动尝试备选音质和兼容播放
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.compatibilityMode" />
        </div>

        <NDivider />

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              备选音质
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              兼容模式下的备选音质选择
            </NText>
          </div>
          <NSelect
            size="small"
            v-model:value="settingStore.backupQuality"
            :options="audioQualityOptions"
            style="width: 150px"
            :disabled="!settingStore.compatibilityMode"
          />
        </div>
      </NCard>

      <!-- 实验功能 -->
      <NCard
        class="setting-group"
        title="实验功能"
        size="small"
      >
        <template #header-extra>
          <NIcon
            :size="20"
            :color="themeVars.primaryColor"
          >
            <Pacman />
          </NIcon>
        </template>

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              自动签到
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              自动签到领取畅听VIP解锁听歌权限
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.autoSign" />
        </div>

        <NDivider />

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              自动领取VIP
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              自动领取概念VIP解锁音质/音效
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.autoReceiveVip" />
        </div>

        <NDivider />

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              歌曲MV
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              获取播放歌曲的MV
            </NText>
          </div>
          <NSwitch v-model:value="settingStore.enabledMV" />
        </div>

        <NDivider />

        <div class="setting-item">
          <div class="setting-info">
            <NText
              :depth="1"
              class="setting-title"
            >
              解灰功能
            </NText>
            <NText
              :depth="3"
              class="setting-desc"
            >
              尝试播放无法正常播放的歌曲
            </NText>
          </div>
          <NSwitch
            v-model:value="settingStore.unblock"
            disabled
          />
        </div>
      </NCard>

      <!-- 关于 -->
      <NCard
        class="setting-group"
        title="关于"
        size="small"
      >
        <template #header-extra>
          <NIcon
            :size="20"
            :color="themeVars.primaryColor"
          >
            <InfoCircle />
          </NIcon>
        </template>

        <div class="about-content">
          <div class="app-info">
            <NText
              tag="h3"
              :depth="1"
              class="app-title"
              >EchoMusic</NText
            >
            <NText
              :depth="2"
              class="app-version"
            >
              版本 1.0.0
            </NText>
            <NText
              :depth="2"
              class="app-description"
            >
              一个现代化的音乐播放器
            </NText>
          </div>

          <div class="links">
            <NButton
              text
              type="primary"
              @click="openLink('https://github.com')"
            >
              <template #icon>
                <NIcon><BrandGithub /></NIcon>
              </template>
              GitHub
            </NButton>
            <NButton
              text
              type="primary"
              @click="openLink('mailto:support@example.com')"
            >
              <template #icon>
                <NIcon><Mail /></NIcon>
              </template>
              反馈建议
            </NButton>
          </div>
        </div>
      </NCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NCard, NSwitch, NSelect, NSlider, NText, NDivider, NIcon, NButton } from 'naive-ui';
import { useSettingStore } from '@/store';
import {
  Palette,
  PlayerPlay,
  InfoCircle,
  Mail,
  DeviceAudioTape,
  BrandGithub,
  Pacman,
} from '@vicons/tabler';
import { useTheme } from '@/hooks';
import { AUDIO_QUALITY_OPTIONS } from '@/constants';
import { useThemeVars } from 'naive-ui';

defineOptions({
  name: 'Setting',
});

const { switchTheme } = useTheme();

const settingStore = useSettingStore();
const themeVars = useThemeVars();

// 主题选项
const themeOptions = [
  { label: '跟随系统', value: 'auto' },
  { label: '浅色模式', value: 'light' },
  { label: '深色模式', value: 'dark' },
];

// 音质选项
const audioQualityOptions = AUDIO_QUALITY_OPTIONS.map(option => ({
  label: option.label,
  value: option.value,
}));

// 打开链接
const openLink = (url: string) => {
  window.open(url, '_blank');
};
</script>

<style scoped lang="scss">
.setting-page {
  padding: 24px;
  max-width: 800px;
  margin: 0 auto;
  min-height: calc(100vh - 100px);
}

.setting-header {
  margin-bottom: 32px;
  text-align: center;

  .header-title {
    font-size: 28px;
    font-weight: 600;
    margin: 0 0 8px 0;
  }

  .header-desc {
    margin: 0;
    font-size: 14px;
  }
}

.setting-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.setting-group {
  :deep(.n-card-header) {
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--border-color);

    .n-card-header__main {
      font-size: 16px;
      font-weight: 600;
    }
  }

  :deep(.n-card__content) {
    padding: 0;
  }
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;

  .setting-info {
    flex: 1;
    margin-right: 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;

    .setting-title {
      font-size: 14px;
      font-weight: 500;
    }

    .setting-desc {
      font-size: 12px;
      line-height: 1.4;
    }
  }

  .setting-control {
    display: flex;
    align-items: center;
    gap: 12px;

    .fade-time-text {
      font-size: 12px;
      min-width: 50px;
      text-align: right;
    }
  }
}

.about-content {
  padding: 24px;

  .app-info {
    text-align: center;
    margin-bottom: 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;

    .app-title {
      font-size: 20px;
      font-weight: 600;
    }

    .app-version,
    .app-description {
      font-size: 14px;
    }
  }

  .links {
    display: flex;
    justify-content: center;
    gap: 16px;
  }
}

:deep(.n-divider) {
  margin: 0;
}
</style>
