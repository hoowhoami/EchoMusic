<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';
import RollingNumber from '@/components/ui/RollingNumber.vue';

defineOptions({ name: 'profile' });
import { computed, onMounted, onUnmounted, reactive, ref, toRaw, watch } from 'vue';
import { captureUserSession } from '@/utils/userSession';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { useLoginDeviceStore, type LoginDeviceSession } from '@/stores/loginDevices';
import Button from '@/components/ui/Button.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import DatePicker from '@/components/ui/DatePicker.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Drawer from '@/components/ui/Drawer.vue';
import Input from '@/components/ui/Input.vue';
import Popover from '@/components/ui/Popover.vue';
import Select from '@/components/ui/Select.vue';
import Textarea from '@/components/ui/Textarea.vue';
import ContentBlacklistDialog from '@/components/profile/ContentBlacklistDialog.vue';
import ListeningPreferencesDialog from '@/components/profile/ListeningPreferencesDialog.vue';
import LogoutConfirmDialog from '@/components/profile/LogoutConfirmDialog.vue';

import Avatar from '@/components/ui/Avatar.vue';
import Tag from '@/components/ui/Tag.vue';

import logger from '@/utils/logger';
import { useToastStore } from '@/stores/toast';
import {
  addUserFollow,
  deleteUserFollow,
  getUserFans,
  getUserFollow,
  getUserFriends,
  getUserFollowMessages,
  getUserVisitors,
  sendUserFollowChat,
  type UpdateUserProfileParams,
} from '@/api/user';
import { normalizeCoverUrl } from '@/utils/cover';
import {
  iconCheck,
  iconChevronLeft,
  iconGift,
  iconHeadphones,
  iconHome,
  iconInfo,
  iconLogOut,
  iconMessageCircle,
  iconMinus,
  iconPencil,
  iconPlus,
  iconRefreshCw,
  iconScan,
  iconSmartphone,
  iconUser,
  iconX,
} from '@/icons';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import { formatBirthdayForInput } from '../../shared/birthday';
import {
  formatAccountAge,
  formatListeningDuration,
  getGradeProgress,
} from '../../shared/profileStats';

interface VipLevelInfo {
  product_type?: string;
  is_vip?: number;
  vip_begin_time?: string | number;
  vip_end_time?: string | number;
}

interface VipInfoState {
  busi_vip?: VipLevelInfo[];
  [key: string]: unknown;
}

interface DetailState {
  gender?: number;
  [key: string]: unknown;
}

const router = useRouter();
const userStore = useUserStore();
const loginDeviceStore = useLoginDeviceStore();
const toastStore = useToastStore();
const userInfo = computed(() => userStore.info);

const isLoading = ref(false);
const showContentBlacklist = ref(false);
const showListeningPreferences = ref(false);
const showDeviceManager = ref(false);
const showKickConfirm = ref(false);
const pendingKickDevice = ref<LoginDeviceSession | null>(null);
const showProfileEditor = ref(false);
const showGradeDetail = ref(false);
const gradeLoading = ref(false);
const gradeProgress = computed(() => getGradeProgress(detail.value));
const listeningDuration = computed(() =>
  formatListeningDuration(detail.value.d_sec, detail.value.duration),
);
const openGradeDetail = async () => {
  if (!userStore.isLoggedIn || disposed || gradeLoading.value) return;
  const isCurrent = captureProfileScope();
  showGradeDetail.value = true;
  gradeLoading.value = true;
  try {
    await userStore.fetchGradeInfo();
  } finally {
    if (isCurrent()) gradeLoading.value = false;
  }
};
const isSavingProfile = ref(false);
const isUploadingAvatar = ref(false);
const avatarInput = ref<HTMLInputElement | null>(null);

type EditableGender = 0 | 1 | 2;

const profileForm = reactive({
  nickname: '',
  sex: 2 as EditableGender,
  birthday: '',
  signature: '',
  province: '',
  city: '',
});

const genderOptions = [
  { label: '女', value: 0 },
  { label: '男', value: 1 },
  { label: '保密', value: 2 },
];

type SocialTabKey = 'follow' | 'friends' | 'fans' | 'visitors';
type RawRecord = Record<string, unknown>;

interface SocialUser {
  key: string;
  userId: string;
  canMessage: boolean;
  nickname: string;
  avatar: string;
  description: string;
  meta: string;
  friendAction: 'follow' | 'unfollow' | '';
  raw: RawRecord;
}

interface ChatMessage {
  id: string;
  text: string;
  imageUrl: string;
  time: string;
  isSelf: boolean;
  nickname: string;
  avatar: string;
  type: number;
  raw: RawRecord;
}

const socialTabs: Array<{ key: SocialTabKey; label: string; empty: string }> = [
  { key: 'friends', label: '好友', empty: '暂无好友记录' },
  { key: 'follow', label: '关注', empty: '暂无关注记录' },
  { key: 'fans', label: '粉丝', empty: '暂无粉丝记录' },
  { key: 'visitors', label: '访客', empty: '暂无访客记录' },
];

const today = new Date();
const birthdayMax = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
  today.getDate(),
).padStart(2, '0')}`;

// 提取详细信息
const detail = computed<DetailState>(
  () => (userInfo.value?.extendsInfo?.detail as DetailState | undefined) || {},
);
const vipInfo = computed<VipInfoState>(
  () => (userInfo.value?.extendsInfo?.vip as VipInfoState | undefined) || {},
);
const busiVip = computed<VipLevelInfo[]>(() => vipInfo.value?.busi_vip || []);
const visitorCount = computed(() => {
  const value = detail.value.hvisitors ?? 0;
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
});
const rawFollowCount = computed(() => {
  const value = detail.value.follows ?? detail.value.follow_count ?? 0;
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
});
const rawFriendCount = computed(() => {
  const value = detail.value.friends ?? detail.value.friend_count ?? 0;
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
});

const socialDrawerOpen = ref(false);
const activeSocialTab = ref<SocialTabKey>('friends');
const socialUsers = reactive<Record<SocialTabKey, SocialUser[]>>({
  follow: [],
  friends: [],
  fans: [],
  visitors: [],
});
const socialLoading = reactive<Record<SocialTabKey, boolean>>({
  follow: false,
  friends: false,
  fans: false,
  visitors: false,
});
const socialLoaded = reactive<Record<SocialTabKey, boolean>>({
  follow: false,
  friends: false,
  fans: false,
  visitors: false,
});
const followCount = computed(() =>
  socialLoaded.follow ? socialUsers.follow.length : rawFollowCount.value,
);
const friendCount = computed(() =>
  socialLoaded.friends ? socialUsers.friends.length : rawFriendCount.value,
);
const socialFollowPending = reactive(new Set<string>());
const socialListRequests: Partial<Record<SocialTabKey, Promise<boolean>>> = {};
const socialError = reactive<Record<SocialTabKey, string>>({
  follow: '',
  friends: '',
  fans: '',
  visitors: '',
});
const socialChatTarget = ref<SocialUser | null>(null);
const socialChatMessages = ref<ChatMessage[]>([]);
const socialChatLoading = ref(false);
const socialChatSending = ref(false);
const socialChatDraft = ref('');
const socialChatTag = ref('');
const SOCIAL_CHAT_TEXT_LIMIT = 200;
const socialChatDraftLength = computed(() => socialChatDraft.value.length);
const socialChatDraftOverLimit = computed(
  () => socialChatDraftLength.value > SOCIAL_CHAT_TEXT_LIMIT,
);
const sentChatMessageIds = reactive<Set<string>>(new Set());

let profileGeneration = 0;
let disposed = false;
let chatGeneration = 0;
let chatRequestSequence = 0;
let profileLoadSequence = 0;
let chatRefreshTimer: number | null = null;
const socialUserScopes = new WeakMap<SocialUser, () => boolean>();

const captureProfileScope = () => {
  const generation = profileGeneration;
  const isCurrentSession = captureUserSession(userStore);
  return () => !disposed && generation === profileGeneration && isCurrentSession();
};

const isCurrentSocialUser = (item: SocialUser) =>
  userStore.isLoggedIn && Boolean(socialUserScopes.get(toRaw(item))?.());

const cancelChatRefresh = () => {
  if (chatRefreshTimer !== null) window.clearTimeout(chatRefreshTimer);
  chatRefreshTimer = null;
};

const resetChat = () => {
  chatGeneration++;
  chatRequestSequence++;
  cancelChatRefresh();
  socialChatTarget.value = null;
  socialChatMessages.value = [];
  socialChatDraft.value = '';
  socialChatTag.value = '';
  socialChatLoading.value = false;
  socialChatSending.value = false;
  sentChatMessageIds.clear();
};

const captureChatScope = (target: SocialUser) => {
  const generation = chatGeneration;
  const isCurrentProfile = captureProfileScope();
  return () =>
    isCurrentProfile() &&
    userStore.isLoggedIn &&
    generation === chatGeneration &&
    target.userId === socialChatTarget.value?.userId;
};

const resetProfileState = () => {
  profileGeneration++;
  profileLoadSequence++;
  resetChat();
  socialDrawerOpen.value = false;
  socialFollowPending.clear();
  for (const { key } of socialTabs) {
    socialUsers[key] = [];
    socialLoading[key] = false;
    socialLoaded[key] = false;
    socialError[key] = '';
    delete socialListRequests[key];
  }
  isLoading.value = false;
  isSavingProfile.value = false;
  isUploadingAvatar.value = false;
  gradeLoading.value = false;
  showProfileEditor.value = false;
  showGradeDetail.value = false;
  showDeviceManager.value = false;
  showKickConfirm.value = false;
  pendingKickDevice.value = null;
  showLogoutConfirm.value = false;
  showContentBlacklist.value = false;
  showListeningPreferences.value = false;
  Object.assign(profileForm, {
    nickname: '',
    sex: 2,
    birthday: '',
    signature: '',
    province: '',
    city: '',
  });
};

const tvip = computed(() => busiVip.value.find((v) => v.product_type === 'tvip' && v.is_vip === 1));
const svip = computed(() => busiVip.value.find((v) => v.product_type === 'svip' && v.is_vip === 1));

const gender = computed(() => {
  const g = detail.value?.gender;
  return g === 1 ? '男' : g === 0 ? '女' : '保密';
});

const editableGender = (): EditableGender => {
  const value = Number(detail.value?.gender);
  return value === 0 || value === 1 ? value : 2;
};

const currentSignature = () => String(detail.value?.descri ?? detail.value?.signature ?? '');

const syncProfileForm = () => {
  profileForm.nickname = String(userInfo.value?.nickname ?? '').trim();
  profileForm.sex = editableGender();
  profileForm.birthday = formatBirthdayForInput(detail.value?.birthday);
  profileForm.signature = currentSignature();
  profileForm.province = String(detail.value?.province ?? '').trim();
  profileForm.city = String(detail.value?.city ?? '').trim();
};

const openProfileEditor = () => {
  syncProfileForm();
  showProfileEditor.value = true;
};

const getProfileErrorMessage = (error: unknown, fallback: string) => {
  const response = (error as { response?: { body?: unknown } } | null)?.response;
  const body =
    response?.body && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : undefined;
  const message = typeof body?.msg === 'string' ? body.msg.trim() : '';
  if (message) return message;
  const ownMessage = error instanceof Error ? error.message.trim() : '';
  return ownMessage && !ownMessage.startsWith('API Error:') ? ownMessage : fallback;
};

const saveProfile = async () => {
  if (!userStore.isLoggedIn || disposed || isSavingProfile.value) return;
  const isCurrent = captureProfileScope();

  const nickname = profileForm.nickname.trim();
  if (!nickname) {
    toastStore.warning('昵称不能为空');
    return;
  }

  const params: UpdateUserProfileParams = {};
  const currentNickname = String(userInfo.value?.nickname ?? '').trim();
  const currentBirthday = formatBirthdayForInput(detail.value?.birthday);
  const birthday = profileForm.birthday.trim();

  if (nickname !== currentNickname) params.nickname = nickname;
  if (profileForm.sex !== editableGender()) params.sex = profileForm.sex;
  if (birthday !== currentBirthday) {
    params.birthday = birthday;
  }
  if (profileForm.signature !== currentSignature()) params.signature = profileForm.signature;

  const province = profileForm.province.trim();
  const city = profileForm.city.trim();
  const currentProvince = String(detail.value?.province ?? '').trim();
  const currentCity = String(detail.value?.city ?? '').trim();
  if ((!province && currentProvince) || (!city && currentCity)) {
    toastStore.warning('当前接口暂不支持清空所在地区');
    return;
  }
  if (province && province !== currentProvince) params.province = province;
  if (city && city !== currentCity) params.city = city;

  if (Object.keys(params).length === 0) {
    toastStore.info('资料没有变化');
    return;
  }

  isSavingProfile.value = true;
  try {
    await userStore.updateProfile(params);
    if (!isCurrent()) return;
    showProfileEditor.value = false;
    toastStore.success('个人资料已更新');
  } catch (error) {
    if (!isCurrent()) return;
    logger.error('Profile', 'Update profile error:', error);
    toastStore.danger(getProfileErrorMessage(error, '个人资料保存失败，请稍后重试'));
  } finally {
    if (isCurrent()) isSavingProfile.value = false;
  }
};

const triggerAvatarPicker = () => {
  if (!isUploadingAvatar.value) avatarInput.value?.click();
};

const readFileAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('图片读取失败'));
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });

const handleAvatarSelected = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !userStore.isLoggedIn || disposed || isUploadingAvatar.value) return;
  const isCurrent = captureProfileScope();

  const mime = file.type.toLowerCase();
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/gif']);
  const supportedExtensions = new Set(['jpg', 'jpeg', 'png', 'gif']);
  if ((mime && !supportedTypes.has(mime)) || (!mime && !supportedExtensions.has(extension))) {
    toastStore.warning('请选择 JPEG、PNG 或 GIF 图片');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toastStore.warning('头像图片不能超过 8 MB');
    return;
  }

  isUploadingAvatar.value = true;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    if (!isCurrent()) return;
    const filename =
      mime === 'image/gif' || extension === 'gif'
        ? 'avatar.gif'
        : mime === 'image/png' || extension === 'png'
          ? 'avatar.png'
          : 'avatar.jpg';
    const result = await userStore.updateAvatar(dataUrl, filename);
    if (!isCurrent()) return;
    toastStore.success(
      result.reviewPending ? '头像已上传，正在审核中' : '头像已提交，审核完成后将正式生效',
    );
  } catch (error) {
    if (!isCurrent()) return;
    logger.error('Profile', 'Update avatar error:', error);
    toastStore.danger(getProfileErrorMessage(error, '头像上传失败，请稍后重试'));
  } finally {
    if (isCurrent()) isUploadingAvatar.value = false;
  }
};

const location = computed(() => {
  const p = detail?.value?.province || '';
  const c = detail?.value?.city || '';
  if (p && c) {
    return `${p} - ${c}`;
  }
  if (p) {
    return p;
  }
  if (c) {
    return c;
  }
  return '-';
});

const ipLocation = computed(() => {
  const value = detail.value?.loc;
  return typeof value === 'string' ? value.trim() : '';
});

const getVipExpireText = (vipData: any) => {
  if (!vipData?.vip_end_time) return null;
  try {
    const expireDate = new Date(vipData.vip_end_time);
    const now = new Date();
    const diff = expireDate.getTime() - now.getTime();
    if (diff < 0) return '已过期';
    const totalMinutes = Math.floor(diff / (1000 * 60));
    const totalHours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days > 365) return `${Math.floor(days / 365)}年后到期`;
    if (days > 30) return `${Math.floor(days / 30)}个月后到期`;
    if (days > 0) return `${days}天后到期`;
    if (totalHours > 0) return `${totalHours}小时后到期`;
    if (totalMinutes > 0) return `${totalMinutes}分钟后到期`;
    return '即将到期';
  } catch {
    return null;
  }
};

// 格式化原始时间字符串为 yyyy-MM-dd HH:mm
const formatVipDate = (value?: string | number) => {
  if (!value) return '--';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
  } catch {
    return String(value);
  }
};

const joinDeviceParts = (...parts: Array<string | number | undefined | null>) =>
  parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(', ');

const formatDeviceLoginType = (value?: string | number) => {
  const text = String(value ?? '').trim();
  if (text === '0') return '账号密码登录';
  if (text === '1') return '手机登录';
  if (text === '2') return '微信登录';
  if (text === '3') return 'QQ登录';
  if (text === '4') return '苹果登录';
  if (text === '5') return '微博登录';
  if (text === '6') return '扫码登录';
  return text ? `未知(${text})` : '未知';
};

const formatDeviceLocation = (value?: string | number) => {
  const parts = String(value ?? '')
    .split(/[\s,，/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) || '';
};

const formatDeviceTime = (value?: string | number) => {
  const text = String(value ?? '').trim();
  if (!text || text === '0') return '';

  const numeric = Number(text);
  const date =
    Number.isFinite(numeric) && /^\d+$/.test(text)
      ? new Date(text.length <= 10 ? numeric * 1000 : numeric)
      : new Date(text);
  if (Number.isNaN(date.getTime())) return text;

  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

const formatDeviceDetailLine = (device: LoginDeviceSession) =>
  joinDeviceParts(formatDeviceLoginType(device.loginType), device.platform);

const formatDeviceActivityLine = (device: LoginDeviceSession) => {
  const time = formatDeviceTime(device.activeTime || device.loginTime);
  const location = formatDeviceLocation(device.location);
  return joinDeviceParts(time ? `${time}` : '', location);
};

const loginDevices = computed(() => loginDeviceStore.devices);
const loginDeviceSummary = computed(() => {
  if (loginDeviceStore.loading && !loginDeviceStore.loaded) return '正在同步登录设备';
  if (loginDeviceStore.error && loginDevices.value.length === 0) return loginDeviceStore.error;
  if (loginDevices.value.length === 0) return '暂无登录设备记录';
  return `当前账号已登录 ${loginDevices.value.length} 台设备`;
});

const activeSocialTabMeta = computed(
  () => socialTabs.find((item) => item.key === activeSocialTab.value) ?? socialTabs[0],
);
const activeSocialUsers = computed(() => socialUsers[activeSocialTab.value]);
const isSocialBusy = computed(() => socialLoading[activeSocialTab.value]);
const socialTabLabels = computed(() => socialTabs.map((item) => item.label));
const activeSocialTabIndex = computed({
  get: () =>
    Math.max(
      0,
      socialTabs.findIndex((item) => item.key === activeSocialTab.value),
    ),
  set: (index: number) => {
    const tab = socialTabs[index]?.key;
    if (tab) selectSocialTab(tab);
  },
});

const isPlainRecord = (value: unknown): value is RawRecord =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const readSocialText = (...values: unknown[]) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
};

const readSocialNumber = (...values: unknown[]) => {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
};

const firstRecord = (...values: unknown[]) => values.find(isPlainRecord) as RawRecord | undefined;

const pickFromRecords = (records: RawRecord[], keys: string[]) => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
  }
  return undefined;
};

const unwrapPayload = (payload: unknown): unknown => {
  if (!isPlainRecord(payload)) return payload;
  const data = payload.data;
  return data !== undefined && data !== null ? data : payload;
};

const findFirstArray = (value: unknown, keys: string[], depth = 0): unknown[] => {
  if (Array.isArray(value)) return value;
  if (!isPlainRecord(value) || depth > 3) return [];

  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isPlainRecord(candidate)) {
      const nested = findFirstArray(candidate, keys, depth + 1);
      if (nested.length) return nested;
    }
  }

  return [];
};

const socialListKeys: Record<SocialTabKey, string[]> = {
  follow: ['lists', 'follow', 'follows', 'follow_list', 'list', 'users', 'items', 'data'],
  friends: ['friends', 'friend_list', 'list', 'lists', 'users', 'items', 'data'],
  fans: ['fans', 'fans_list', 'list', 'lists', 'users', 'items', 'data'],
  visitors: ['visitors', 'visitor_list', 'visit_list', 'list', 'lists', 'users', 'items', 'data'],
};

const formatSocialTime = (value: unknown) => {
  const text = readSocialText(value);
  if (!text) return '';

  const numeric = Number(text);
  const date =
    Number.isFinite(numeric) && /^\d+$/.test(text)
      ? new Date(text.length <= 10 ? numeric * 1000 : numeric)
      : new Date(text);
  if (Number.isNaN(date.getTime())) return text;

  const pad = (n: number) => n.toString().padStart(2, '0');
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
        date.getMinutes(),
      )}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const readSocialLabel = (...values: unknown[]) => {
  for (const value of values) {
    const text = readSocialText(value);
    if (!text || /^\d+$/.test(text)) continue;
    return text;
  }
  return '';
};

const resolveFollowMeta = (records: RawRecord[]) => {
  return readSocialLabel(
    pickFromRecords(records, [
      'source_desc',
      'identity_desc',
      'identity_name',
      'iden_desc',
      'auth_desc',
      'tag_name',
      'tag',
      'label',
      'category',
    ]),
  );
};

const resolveSocialMeta = (records: RawRecord[], tab: SocialTabKey, timeText: string) => {
  if (tab === 'follow') return resolveFollowMeta(records);
  if (tab === 'friends') return '互相关注';
  if (tab === 'fans') {
    return readSocialLabel(
      pickFromRecords(records, ['source_desc', 'identity_desc', 'identity_name', 'auth_desc']),
    );
  }
  return timeText ? `最近访问 ${timeText}` : '主页访客';
};

const socialTabFetcher: Record<SocialTabKey, () => Promise<unknown>> = {
  follow: () => getUserFollow(),
  friends: () => getUserFriends(),
  fans: () => getUserFans(),
  visitors: () => getUserVisitors(1),
};

const mapSocialUser = (item: unknown, index: number, tab: SocialTabKey): SocialUser | null => {
  if (!isPlainRecord(item)) return null;
  const nested = [
    item,
    firstRecord(item.user),
    firstRecord(item.profile),
    firstRecord(item.info),
    firstRecord(item.visitor),
    firstRecord(item.friend),
    firstRecord(item.fans),
    firstRecord(item.singer),
    firstRecord(item.artist),
  ].filter((record): record is RawRecord => Boolean(record));

  const userId = readSocialText(
    pickFromRecords(nested, [
      'userid',
      'user_id',
      'userId',
      'uid',
      'id',
      't_userid',
      'visit_userid',
      'friend_userid',
      'fan_userid',
      'singerid',
      'singer_id',
      'author_id',
    ]),
  );
  if (tab === 'follow' && userId === '0') return null;
  const nickname =
    readSocialText(
      pickFromRecords(nested, [
        'nickname',
        'nick_name',
        'nick',
        'username',
        'user_name',
        'singername',
        'singer_name',
        'author_name',
        'name',
      ]),
    ) || `用户 ${userId || index + 1}`;
  const avatar = normalizeCoverUrl(
    readSocialText(
      pickFromRecords(nested, [
        'sizable_avatar',
        'avatar',
        'user_pic',
        'headimg',
        'head_img',
        'img',
        'pic',
        'sizable_cover',
        'cover',
      ]),
    ),
    160,
  );
  const description = readSocialText(
    pickFromRecords(nested, ['signature', 'descri', 'description', 'intro', 'mood', 'memo']),
  );
  const timeText = formatSocialTime(
    pickFromRecords(nested, [
      'visit_time',
      'visitor_time',
      'time',
      'ctime',
      'add_time',
      'update_time',
      'lasttime',
    ]),
  );
  const relationText = resolveSocialMeta(nested, tab, timeText);
  const isFriend = readSocialText(pickFromRecords(nested, ['is_friend', 'isFriend']));
  // 社交写接口只接受用户 ID，不能使用歌手 ID 或无身份信息的列表行 ID。
  const followUserId = readSocialText(
    pickFromRecords(nested, [
      'userid',
      'user_id',
      'userId',
      'uid',
      't_userid',
      'visit_userid',
      'friend_userid',
      'fan_userid',
    ]),
  );
  const canFollow =
    followUserId === userId &&
    /^[1-9]\d*$/.test(userId) &&
    String(userStore.info?.userid ?? '') !== userId;
  const friendAction = !canFollow
    ? ''
    : tab === 'follow' || tab === 'friends' || (tab === 'fans' && isFriend === '1')
      ? 'unfollow'
      : tab === 'fans' && isFriend === '0'
        ? 'follow'
        : '';
  const rawId = userId || `row-${tab}-${index}`;

  const mapped: SocialUser = {
    key: rawId,
    userId,
    canMessage: Boolean(userId && String(userStore.info?.userid ?? '') !== userId),
    nickname,
    avatar,
    description,
    meta: relationText,
    friendAction,
    raw: item,
  };
  socialUserScopes.set(mapped, captureProfileScope());
  return mapped;
};

const getSocialErrorMessage = (error: unknown, fallback: string) => {
  const response = (error as { response?: { body?: unknown } } | null)?.response;
  const body =
    response?.body && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : undefined;
  const message = readSocialText(
    body?.msg,
    body?.error,
    body?.errmsg,
    error instanceof Error ? error.message : '',
  );
  return message && !message.startsWith('API Error:') ? message : fallback;
};

const loadSocialList = async (tab = activeSocialTab.value, force = false) => {
  if (!userStore.isLoggedIn || disposed) return false;
  const isCurrent = captureProfileScope();
  // 写操作后的刷新必须等旧请求结束，再取一次，避免拿到操作前的关系。
  while (socialListRequests[tab]) {
    const loaded = await socialListRequests[tab];
    if (!isCurrent()) return false;
    if (!force) return loaded;
  }
  if (socialLoaded[tab] && !force) return true;

  socialLoading[tab] = true;
  socialError[tab] = '';
  const pending = (async () => {
    try {
      const payload = await socialTabFetcher[tab]();
      if (!isCurrent()) return false;
      const records = findFirstArray(unwrapPayload(payload), socialListKeys[tab]);
      socialUsers[tab] = records
        .map((item, index) => mapSocialUser(item, index, tab))
        .filter((item): item is SocialUser => Boolean(item));
      socialLoaded[tab] = true;
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      logger.error('Profile', `Load ${tab} failed:`, error);
      socialError[tab] = getSocialErrorMessage(error, '列表加载失败，请稍后重试');
      return false;
    } finally {
      if (isCurrent()) socialLoading[tab] = false;
    }
  })();
  if (isCurrent()) socialListRequests[tab] = pending;
  try {
    return await pending;
  } finally {
    if (socialListRequests[tab] === pending) delete socialListRequests[tab];
  }
};

const toggleSocialFollow = async (item: SocialUser) => {
  if (
    !isCurrentSocialUser(item) ||
    !item.friendAction ||
    socialFollowPending.has(item.userId) ||
    !/^[1-9]\d*$/.test(item.userId) ||
    String(userStore.info?.userid ?? '') === item.userId
  )
    return;

  const isCurrent = captureProfileScope();
  const following = item.friendAction === 'follow';
  socialFollowPending.add(item.userId);
  try {
    let alreadyFollowed = false;
    try {
      const payload = await (following ? addUserFollow : deleteUserFollow)({ tuid: item.userId });
      if (!isCurrent()) return;
      if (
        !isPlainRecord(payload) ||
        Number(payload.status) !== 1 ||
        Number(payload.error_code ?? 0) !== 0
      ) {
        throw Object.assign(new Error('关注操作失败'), { response: { body: payload } });
      }
    } catch (error) {
      if (!isCurrent()) return;
      const body = (error as { response?: { body?: RawRecord } })?.response?.body;
      if (!following || Number(body?.error_code) !== 31702) throw error;
      alreadyFollowed = true;
    }

    if (alreadyFollowed) toastStore.info('已关注该用户');
    else toastStore.success(following ? '关注成功' : '已取消关注');
    const refreshed = await Promise.all(
      (['follow', 'friends', 'fans'] as const).map((tab) =>
        isCurrent() ? loadSocialList(tab, true) : Promise.resolve(false),
      ),
    );
    if (isCurrent() && refreshed.some((loaded) => !loaded)) {
      toastStore.warning('关系已更新，部分列表刷新失败，请重试');
    }
  } catch (error) {
    if (!isCurrent()) return;
    logger.error('Profile', 'Update follow failed:', error);
    toastStore.warning(
      getSocialErrorMessage(error, following ? '关注失败，请稍后重试' : '取消关注失败，请稍后重试'),
    );
  } finally {
    if (isCurrent()) socialFollowPending.delete(item.userId);
  }
};

const openSocialDrawer = (tab: SocialTabKey) => {
  activeSocialTab.value = tab;
  resetChat();
  socialDrawerOpen.value = true;
  void loadSocialList(tab);
};

const selectSocialTab = (tab: SocialTabKey) => {
  activeSocialTab.value = tab;
  resetChat();
  void loadSocialList(tab);
};

const refreshSocialList = () => {
  void loadSocialList(activeSocialTab.value, true);
};

const getMessageRecords = (payload: unknown) =>
  findFirstArray(unwrapPayload(payload), ['messages', 'msgs', 'list', 'lists', 'items', 'data']);

const resolveMessageBody = (record: RawRecord) => {
  const message = firstRecord(record.message, record.msg, record.content);
  const source = message ?? record;
  const type = readSocialNumber(source.msgtype, source.type, record.msgtype, record.type);
  const text = readSocialText(
    source.alert,
    source.text,
    source.content,
    source.msg,
    record.alert,
    record.text,
  );
  const imageUrl = normalizeCoverUrl(
    readSocialText(source.url, source.pic, source.img, source.image, record.url),
    320,
  );
  return { source, type, text, imageUrl };
};

const readChatMessageId = (record: RawRecord, source: RawRecord) =>
  readSocialText(record.msgid, record.msg_id, record.id, source.msgid, source.msg_id, source.id);

const readChatPartyId = (record: RawRecord, source: RawRecord, keys: string[]) =>
  readSocialText(...keys.flatMap((key) => [record[key], source[key]]));

const readChatDirection = (record: RawRecord, source: RawRecord) =>
  readSocialText(
    record.is_self,
    record.isSelf,
    record.is_me,
    record.isMe,
    record.self,
    record.mine,
    record.is_send,
    record.isSend,
    record.from_me,
    record.fromMe,
    record.direction,
    record.flow,
    source.is_self,
    source.isSelf,
    source.is_me,
    source.isMe,
    source.self,
    source.mine,
    source.is_send,
    source.isSend,
    source.from_me,
    source.fromMe,
    source.direction,
    source.flow,
  ).toLowerCase();

const isSelfDirection = (value: string) =>
  ['1', 'true', 'self', 'me', 'mine', 'send', 'sent', 'out', 'outgoing', 'right'].includes(value);

const mapChatMessage = (item: unknown, index: number): ChatMessage | null => {
  if (!isPlainRecord(item)) return null;
  const currentUserId = String(userStore.info?.userid ?? '');
  const { source, type, text, imageUrl } = resolveMessageBody(item);
  const messageId = readChatMessageId(item, source);
  const senderId = readChatPartyId(item, source, [
    'fromuid',
    'from_uid',
    'from_userid',
    'from_user_id',
    'senderid',
    'sender_id',
    'send_uid',
    'send_userid',
    'uid',
    'userid',
    'user_id',
  ]);
  const receiverId = readChatPartyId(item, source, [
    'touid',
    'to_uid',
    'to_userid',
    'to_user_id',
    'receiverid',
    'receiver_id',
    'targetid',
    'target_id',
    'tuid',
  ]);
  const targetUserId = socialChatTarget.value?.userId || '';
  const direction = readChatDirection(item, source);
  const isSelf =
    Boolean(messageId && sentChatMessageIds.has(messageId)) ||
    isSelfDirection(direction) ||
    Boolean(currentUserId && senderId && senderId === currentUserId) ||
    Boolean(receiverId && targetUserId && receiverId === targetUserId);

  return {
    id: messageId || `message-${index}`,
    text: text || (type === 202 ? '[图片]' : type === 205 ? '[表情]' : '[消息]'),
    imageUrl,
    time: formatSocialTime(
      item.time ?? item.timestamp ?? item.ctime ?? item.addtime ?? source.time ?? source.ctime,
    ),
    isSelf,
    nickname: isSelf
      ? userInfo.value?.nickname || '我'
      : socialChatTarget.value?.nickname || '对方',
    avatar: isSelf ? userInfo.value?.pic || '' : socialChatTarget.value?.avatar || '',
    type,
    raw: item,
  };
};

const loadChatMessages = async (
  target = socialChatTarget.value,
  options: { silent?: boolean } = {},
) => {
  if (
    !target?.userId ||
    !isCurrentSocialUser(target) ||
    target.userId !== socialChatTarget.value?.userId
  )
    return;
  const isCurrentChat = captureChatScope(target);
  const sequence = ++chatRequestSequence;
  const isCurrent = () => isCurrentChat() && sequence === chatRequestSequence;
  socialChatLoading.value = !options.silent;
  try {
    const payload = await getUserFollowMessages({ id: target.userId, pagesize: 30 });
    if (!isCurrent()) return;
    const records = getMessageRecords(payload);
    const firstRecordWithTag = records.find(
      (record): record is RawRecord => isPlainRecord(record) && Boolean(readSocialText(record.tag)),
    );
    const tag = readSocialText(
      isPlainRecord(payload) ? payload.tag : '',
      isPlainRecord(payload) && isPlainRecord(payload.data) ? payload.data.tag : '',
      firstRecordWithTag?.tag,
    );
    if (tag) socialChatTag.value = tag;
    socialChatMessages.value = records
      .map(mapChatMessage)
      .filter((item): item is ChatMessage => Boolean(item))
      .reverse();
  } catch (error) {
    if (!isCurrent()) return;
    logger.error('Profile', 'Load chat messages failed:', error);
    toastStore.warning(getSocialErrorMessage(error, '私信记录加载失败'));
  } finally {
    if (isCurrent()) socialChatLoading.value = false;
  }
};

const openSocialChat = (target: SocialUser) => {
  if (!target.canMessage || !isCurrentSocialUser(target)) return;
  resetChat();
  socialChatTarget.value = target;
  void loadChatMessages(target);
};

const closeSocialChat = () => resetChat();

const rememberSocialChatTag = (payload: unknown) => {
  const responseRecord = isPlainRecord(payload) ? payload : {};
  const dataRecord = firstRecord(responseRecord.data) ?? {};
  const tag = readSocialText(
    responseRecord.tag,
    responseRecord.chat_tag,
    responseRecord.chatTag,
    dataRecord.tag,
    dataRecord.chat_tag,
    dataRecord.chatTag,
  );
  if (tag) socialChatTag.value = tag;
};

const readSentChatMessageId = (payload: unknown) => {
  const responseRecord = isPlainRecord(payload) ? payload : {};
  const dataRecord = firstRecord(responseRecord.data) ?? {};
  return readSocialText(
    responseRecord.msgid,
    responseRecord.msg_id,
    responseRecord.id,
    dataRecord.msgid,
    dataRecord.msg_id,
    dataRecord.id,
  );
};

const rememberSentChatMessage = (messageId = '') => {
  if (messageId) sentChatMessageIds.add(messageId);
};

const sendSocialChat = async () => {
  const target = socialChatTarget.value;
  const draft = socialChatDraft.value;
  const text = draft.trim();
  if (!target?.userId || !isCurrentSocialUser(target) || !text || socialChatSending.value) return;
  const isCurrent = captureChatScope(target);
  if (text.length > SOCIAL_CHAT_TEXT_LIMIT) {
    toastStore.warning(`私信最多 ${SOCIAL_CHAT_TEXT_LIMIT} 字`);
    return;
  }

  socialChatSending.value = true;
  try {
    const chatTarget = socialChatTag.value ? { tag: socialChatTag.value } : { tuid: target.userId };
    const payload = await sendUserFollowChat({
      ...chatTarget,
      alert: text,
      nickname: userInfo.value?.nickname,
    });
    if (!isCurrent()) return;
    chatRequestSequence++;
    socialChatLoading.value = false;
    rememberSocialChatTag(payload);
    const messageId = readSentChatMessageId(payload);
    rememberSentChatMessage(messageId);
    socialChatMessages.value = [
      ...socialChatMessages.value.filter((message) => message.id !== messageId),
      {
        id: messageId || `local-${Date.now()}`,
        text,
        imageUrl: '',
        time: formatSocialTime(Date.now()),
        isSelf: true,
        nickname: userInfo.value?.nickname || '我',
        avatar: userInfo.value?.pic || '',
        type: 201,
        raw: {},
      },
    ];
    if (socialChatDraft.value === draft) socialChatDraft.value = '';
    toastStore.success('私信已发送');
    cancelChatRefresh();
    const timer = window.setTimeout(() => {
      if (chatRefreshTimer === timer) chatRefreshTimer = null;
      if (isCurrent()) void loadChatMessages(target, { silent: true });
    }, 350);
    chatRefreshTimer = timer;
  } catch (error) {
    if (!isCurrent()) return;
    logger.error('Profile', 'Send chat failed:', error);
    toastStore.warning(getSocialErrorMessage(error, '私信发送失败'));
  } finally {
    if (isCurrent()) socialChatSending.value = false;
  }
};

const loadData = async () => {
  if (!userStore.isLoggedIn || disposed) return;
  const isCurrentProfile = captureProfileScope();
  const sequence = ++profileLoadSequence;
  const isCurrent = () => isCurrentProfile() && sequence === profileLoadSequence;
  isLoading.value = true;
  try {
    await userStore.fetchUserInfo();
    if (!isCurrent()) return;
    // 并行刷新听歌等级信息（等级/积分），不阻塞主流程
    void userStore.fetchGradeInfo();
    if (!isCurrent()) return;
    void loginDeviceStore.fetchDevices();
    if (!isCurrent()) return;
    void loadSocialList('follow');
  } catch (e) {
    if (isCurrent()) logger.error('Profile', 'Load Data Error:', e);
  } finally {
    if (isCurrent()) isLoading.value = false;
  }
};

const handleLogout = () => {
  showLogoutConfirm.value = true;
};

const confirmLogout = () => {
  showLogoutConfirm.value = false;
  loginDeviceStore.reset();
  userStore.logout();
  router.push('/main/home');
};

const openDeviceManager = async () => {
  showDeviceManager.value = true;
  if (!loginDeviceStore.loaded && !loginDeviceStore.loading) {
    await loginDeviceStore.fetchDevices();
  }
};

const refreshLoginDevices = async () => {
  await loginDeviceStore.fetchDevices();
};

const requestKickDevice = (device: LoginDeviceSession) => {
  if (!device.canKick) return;
  pendingKickDevice.value = device;
  showKickConfirm.value = true;
};

const confirmKickDevice = async () => {
  const device = pendingKickDevice.value;
  if (!device) return;
  const isCurrent = captureProfileScope();
  const ok = await loginDeviceStore.kickDevice(device);
  if (ok && isCurrent() && pendingKickDevice.value === device) {
    showKickConfirm.value = false;
    pendingKickDevice.value = null;
  }
};

const showLogoutConfirm = ref(false);

const profileSessionSources = [
  () => userStore.isLoggedIn,
  () => userStore.accountRevision,
  () => userStore.info?.userid,
  () => userStore.info?.userId,
  () => userStore.info?.token,
];
watch(profileSessionSources, resetProfileState, { flush: 'sync' });
watch(profileSessionSources, () => void loadData());
watch(
  socialDrawerOpen,
  (open) => {
    if (!open) resetChat();
  },
  { flush: 'sync' },
);
onMounted(() => loadData());
onUnmounted(() => {
  disposed = true;
  resetProfileState();
});
</script>

<template>
  <PageScrollContainer class="profile-page-container">
    <div class="profile-page select-none bg-bg-main">
      <template v-if="userStore.isLoggedIn && userInfo">
        <div class="px-8 py-4">
          <div class="w-full">
            <!-- 1. Header -->
            <header class="flex items-center justify-between mb-6">
              <h1 class="text-[22px] font-black tracking-tight">个人中心</h1>
              <div class="flex items-center gap-2">
                <Button
                  variant="unstyled"
                  size="none"
                  @click="openProfileEditor"
                  class="w-10 h-10 flex items-center justify-center rounded-full border border-[var(--control-border)] text-[var(--icon-main)] hover:bg-[var(--control-hover-bg)] hover:text-text-main transition-all active:scale-90"
                  tooltip="编辑个人资料"
                  aria-label="编辑个人资料"
                >
                  <Icon :icon="iconPencil" width="19" height="19" />
                </Button>
                <Button
                  variant="unstyled"
                  size="none"
                  @click="showListeningPreferences = true"
                  class="w-10 h-10 flex items-center justify-center rounded-full border border-[var(--control-border)] text-[var(--icon-main)] hover:bg-[var(--control-hover-bg)] hover:text-text-main transition-all active:scale-90"
                  tooltip="听歌偏好"
                  aria-label="听歌偏好"
                >
                  <Icon :icon="iconHeadphones" width="20" height="20" />
                </Button>
                <Button
                  variant="unstyled"
                  size="none"
                  @click="openDeviceManager"
                  class="w-10 h-10 flex items-center justify-center rounded-full border border-[var(--control-border)] text-[var(--icon-main)] hover:bg-[var(--control-hover-bg)] hover:text-text-main transition-all active:scale-90"
                  tooltip="登录设备"
                  aria-label="登录设备"
                >
                  <Icon :icon="iconSmartphone" width="20" height="20" />
                </Button>
                <Button
                  variant="unstyled"
                  size="none"
                  @click="handleLogout"
                  class="w-10 h-10 flex items-center justify-center rounded-full border border-[var(--control-border)] hover:bg-red-500/10 hover:text-red-500 transition-all active:scale-90"
                  tooltip="退出登录"
                  aria-label="退出登录"
                >
                  <Icon :icon="iconLogOut" width="20" height="20" />
                </Button>
              </div>
            </header>

            <!-- 2. User Profile Card -->
            <div
              class="user-card relative overflow-hidden p-6 rounded-3xl bg-linear-to-br from-primary/12 via-primary/6 to-transparent border border-primary/20 mb-6"
            >
              <Tag v-if="ipLocation" class="profile-ip-location">{{ ipLocation }}</Tag>
              <div class="flex items-center gap-6 relative z-10">
                <Tooltip content="修改头像">
                  <template #trigger>
                    <button
                      type="button"
                      class="profile-avatar-button group relative p-1 rounded-full border-2 border-primary/30 shrink-0 overflow-hidden"
                      :disabled="isUploadingAvatar"
                      aria-label="修改头像"
                      @click="triggerAvatarPicker"
                    >
                      <Avatar :src="userInfo.pic" class="w-19 h-19 rounded-full" />
                      <span
                        class="absolute inset-1 rounded-full flex items-center justify-center bg-black/45 text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
                      >
                        <span
                          v-if="isUploadingAvatar"
                          class="w-5 h-5 rounded-full border-2 border-white border-t-transparent animate-spin"
                        ></span>
                        <Icon v-else :icon="iconPencil" width="20" height="20" />
                      </span>
                    </button>
                  </template>
                </Tooltip>
                <input
                  ref="avatarInput"
                  type="file"
                  accept="image/jpeg,image/png,image/gif"
                  hidden
                  @change="handleAvatarSelected"
                />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-3 mb-2 min-w-0">
                    <h2 class="text-[20px] font-black truncate">{{ userInfo.nickname }}</h2>
                    <div
                      v-if="tvip"
                      class="px-1.5 py-0.5 rounded-md bg-linear-to-r from-[#07C160] to-[#07C160]/80 text-white text-[9px] font-black shadow-sm shrink-0"
                    >
                      畅听
                    </div>
                    <div
                      v-if="svip"
                      class="px-1.5 py-0.5 rounded-md bg-linear-to-r from-orange-500 to-orange-500/80 text-white text-[9px] font-black shadow-sm shrink-0"
                    >
                      概念
                    </div>
                  </div>
                  <div class="flex flex-col">
                    <p
                      v-if="detail.descri"
                      class="text-[12px] text-text-secondary font-medium line-clamp-2 mb-3"
                    >
                      {{ detail.descri }}
                    </p>

                    <div class="profile-stats">
                      <button
                        type="button"
                        class="grade-entry profile-stat text-left"
                        aria-label="查看我的等级与升级进度"
                        @click="openGradeDetail"
                      >
                        <span class="profile-stat-value"
                          ><RollingNumber :value="`Lv.${gradeProgress.grade ?? '—'}`" />
                          <span class="text-primary-text">›</span></span
                        >
                        <span class="profile-stat-label">升级进度</span>
                      </button>
                      <button
                        type="button"
                        class="profile-stat profile-social-stat text-left"
                        aria-label="查看好友列表"
                        @click="openSocialDrawer('friends')"
                      >
                        <span class="profile-stat-value">
                          <RollingNumber :value="friendCount" />
                          <span class="text-primary-text">›</span>
                        </span>
                        <span class="profile-stat-label">好友</span>
                      </button>
                      <button
                        type="button"
                        class="profile-stat profile-social-stat text-left"
                        aria-label="查看关注列表"
                        @click="openSocialDrawer('follow')"
                      >
                        <span class="profile-stat-value">
                          <RollingNumber :value="followCount" />
                          <span class="text-primary-text">›</span>
                        </span>
                        <span class="profile-stat-label">关注</span>
                      </button>
                      <button
                        type="button"
                        class="profile-stat profile-social-stat text-left"
                        aria-label="查看粉丝列表"
                        @click="openSocialDrawer('fans')"
                      >
                        <span class="profile-stat-value">
                          <RollingNumber :value="String(detail.fans || 0)" />
                          <span class="text-primary-text">›</span>
                        </span>
                        <span class="profile-stat-label">粉丝</span>
                      </button>
                      <button
                        type="button"
                        class="profile-stat profile-social-stat text-left"
                        aria-label="查看访客列表"
                        @click="openSocialDrawer('visitors')"
                      >
                        <span class="profile-stat-value"
                          ><RollingNumber :value="visitorCount" /><span class="text-primary-text"
                            >›</span
                          ></span
                        >
                        <span class="profile-stat-label">访客</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <!-- 装饰背景 -->
              <div
                class="absolute -right-10 -bottom-10 w-40 h-40 bg-primary/5 rounded-full blur-3xl pointer-events-none"
              ></div>
            </div>

            <div class="profile-info-grid grid gap-6">
              <!-- 3. Account Archives -->
              <div class="min-w-0">
                <div class="flex items-center gap-2 mb-4">
                  <Icon :icon="iconUser" width="16" height="16" class="text-primary-text" />
                  <h3 class="text-[16px] font-black">账号档案</h3>
                </div>
                <div
                  class="profile-archive-card space-y-0.5 p-2 rounded-[18px] bg-[var(--content-panel-bg)] border border-[var(--content-panel-border)] shadow-sm"
                >
                  <div class="flex items-center justify-between px-4 py-3">
                    <span class="text-[13px] text-text-secondary font-bold">用户 ID</span>
                    <span class="text-[13px] font-black">{{ userInfo.userid }}</span>
                  </div>
                  <div class="flex items-center justify-between px-4 py-3">
                    <span class="text-[13px] text-text-secondary font-bold">性别</span>
                    <span class="text-[13px] font-black">{{ gender }}</span>
                  </div>
                  <div class="flex items-center justify-between px-4 py-3">
                    <span class="text-[13px] text-text-secondary font-bold">乐龄</span>
                    <RollingNumber
                      class="text-[13px] font-black"
                      :value="formatAccountAge(detail.rtime)"
                    />
                  </div>
                  <div class="flex items-center justify-between px-4 py-3">
                    <span class="text-[13px] text-text-secondary font-bold">累计听歌</span>
                    <RollingNumber class="text-[13px] font-black" :value="listeningDuration" />
                  </div>
                  <div class="flex items-center justify-between px-4 py-3">
                    <span class="text-[13px] text-text-secondary font-bold">所在地区</span>
                    <span class="text-[13px] font-black">{{ location }}</span>
                  </div>
                </div>
              </div>

              <!-- 4. Membership Status -->
              <div class="min-w-0">
                <div class="flex items-center gap-2 mb-4">
                  <Icon :icon="iconGift" width="16" height="16" class="text-primary-text" />
                  <h3 class="text-[16px] font-black">会员状态</h3>
                </div>
                <div class="space-y-2">
                  <!-- TVIP -->
                  <div
                    :class="[
                      'flex items-center gap-3 p-3 rounded-2xl border',
                      tvip
                        ? 'bg-green-500/10 border-green-500/20'
                        : 'bg-[var(--control-muted-bg)] border-transparent',
                    ]"
                  >
                    <div
                      :class="[
                        'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                        tvip
                          ? 'bg-green-500/20 text-green-500'
                          : 'bg-[var(--control-hover-bg)] text-[var(--icon-main)]',
                      ]"
                    >
                      <Icon :icon="iconHome" width="18" height="18" />
                    </div>
                    <div class="flex-1">
                      <h4 :class="['text-[13px] font-black', tvip ? 'text-green-500' : '']">
                        畅听会员
                      </h4>
                      <div v-if="tvip" @click.stop>
                        <Popover
                          trigger="hover"
                          side="top"
                          align="start"
                          :side-offset="6"
                          contentClass="vip-expire-popover"
                        >
                          <template #trigger>
                            <span
                              class="inline-flex items-center gap-1 text-[11px] text-text-secondary font-bold uppercase cursor-pointer hover:text-text-main transition-colors"
                            >
                              {{ getVipExpireText(tvip) }}
                              <Icon
                                :icon="iconInfo"
                                width="14"
                                height="14"
                                class="text-[var(--icon-main)]"
                              />
                            </span>
                          </template>

                          <div class="min-w-45 space-y-1.5 text-[13px] normal-case">
                            <div class="flex items-center justify-between gap-3">
                              <span class="font-bold text-text-secondary">开始时间</span>
                              <span class="font-black">{{
                                formatVipDate(tvip.vip_begin_time)
                              }}</span>
                            </div>
                            <div class="flex items-center justify-between gap-3">
                              <span class="font-bold text-text-secondary">到期时间</span>
                              <span class="font-black text-green-500">{{
                                formatVipDate(tvip.vip_end_time)
                              }}</span>
                            </div>
                          </div>
                        </Popover>
                      </div>
                      <p v-else class="text-[11px] text-text-secondary font-bold uppercase">
                        未开通
                      </p>
                    </div>
                    <div v-if="tvip" class="text-green-500">
                      <Icon :icon="iconCheck" width="16" height="16" />
                    </div>
                  </div>

                  <!-- SVIP -->
                  <div
                    :class="[
                      'flex items-center gap-3 p-3 rounded-2xl border',
                      svip
                        ? 'bg-orange-500/10 border-orange-500/20'
                        : 'bg-[var(--control-muted-bg)] border-transparent',
                    ]"
                  >
                    <div
                      :class="[
                        'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                        svip
                          ? 'bg-orange-500/20 text-orange-500'
                          : 'bg-[var(--control-hover-bg)] text-[var(--icon-main)]',
                      ]"
                    >
                      <Icon :icon="iconScan" width="18" height="18" />
                    </div>
                    <div class="flex-1">
                      <h4 :class="['text-[13px] font-black', svip ? 'text-orange-500' : '']">
                        概念会员
                      </h4>
                      <div v-if="svip" @click.stop>
                        <Popover
                          trigger="hover"
                          side="top"
                          align="start"
                          :side-offset="6"
                          contentClass="vip-expire-popover"
                        >
                          <template #trigger>
                            <span
                              class="inline-flex items-center gap-1 text-[11px] text-text-secondary font-bold uppercase cursor-pointer hover:text-text-main transition-colors"
                            >
                              {{ getVipExpireText(svip) }}
                              <Icon
                                :icon="iconInfo"
                                width="14"
                                height="14"
                                class="text-[var(--icon-main)]"
                              />
                            </span>
                          </template>

                          <div class="min-w-45 space-y-1.5 text-[13px] normal-case">
                            <div class="flex items-center justify-between gap-3">
                              <span class="font-bold text-text-secondary">开始时间</span>
                              <span class="font-black">{{
                                formatVipDate(svip.vip_begin_time)
                              }}</span>
                            </div>
                            <div class="flex items-center justify-between gap-3">
                              <span class="font-bold text-text-secondary">到期时间</span>
                              <span class="font-black text-orange-500">{{
                                formatVipDate(svip.vip_end_time)
                              }}</span>
                            </div>
                          </div>
                        </Popover>
                      </div>
                      <p v-else class="text-[11px] text-text-secondary font-bold uppercase">
                        未开通
                      </p>
                    </div>
                    <div v-if="svip" class="text-orange-500">
                      <Icon :icon="iconCheck" width="16" height="16" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div
        v-else
        class="h-full flex flex-col items-center justify-center text-text-secondary italic"
      >
        <Icon :icon="iconUser" width="64" height="64" class="mb-4" />
        <span class="text-[16px] font-bold">请先登录以查看个人中心</span>
        <Button
          variant="primary"
          size="sm"
          @click="router.push('/login')"
          class="mt-6 rounded-full not-italic"
          >立即登录</Button
        >
      </div>
    </div>

    <LogoutConfirmDialog v-model:open="showLogoutConfirm" @confirm="confirmLogout" />

    <Dialog
      v-model:open="showProfileEditor"
      title="编辑个人资料"
      description="修改后的资料会同步到当前酷狗账号。"
      contentClass="profile-editor-dialog"
      :showClose="true"
      :closeOnEscape="!isSavingProfile"
      :closeOnInteractOutside="!isSavingProfile"
    >
      <div class="profile-editor-form">
        <label class="profile-editor-field">
          <span>昵称</span>
          <Input v-model="profileForm.nickname" placeholder="请输入昵称" />
        </label>

        <div class="profile-editor-row">
          <label class="profile-editor-field">
            <span>性别</span>
            <div class="profile-editor-select">
              <Select
                v-model="profileForm.sex"
                class="profile-editor-select-trigger"
                :options="genderOptions"
                placeholder="请选择性别"
                aria-label="性别"
              />
            </div>
          </label>
          <label class="profile-editor-field">
            <span>生日</span>
            <DatePicker
              v-model="profileForm.birthday"
              min="1900-01-01"
              :max="birthdayMax"
              placeholder="请选择生日"
              aria-label="生日"
              clearable
            />
          </label>
        </div>

        <div class="profile-editor-row">
          <label class="profile-editor-field">
            <span>省份</span>
            <Input v-model="profileForm.province" placeholder="例如：广东" />
          </label>
          <label class="profile-editor-field">
            <span>城市</span>
            <Input v-model="profileForm.city" placeholder="例如：广州" />
          </label>
        </div>

        <label class="profile-editor-field">
          <span>个性签名</span>
          <Textarea
            v-model="profileForm.signature"
            :rows="3"
            placeholder="写下一句想说的话"
            textareaClass="profile-editor-signature"
          />
          <small>留空保存可清除个性签名</small>
        </label>
      </div>
      <template #footer>
        <Button
          variant="outline"
          size="sm"
          :disabled="isSavingProfile"
          @click="showProfileEditor = false"
          >取消</Button
        >
        <Button variant="primary" size="sm" :loading="isSavingProfile" @click="saveProfile"
          >保存修改</Button
        >
      </template>
    </Dialog>

    <ContentBlacklistDialog v-model:open="showContentBlacklist" />
    <ListeningPreferencesDialog
      v-model:open="showListeningPreferences"
      @blacklist="showContentBlacklist = true"
    />

    <Drawer
      v-model:open="socialDrawerOpen"
      overlayClass="profile-social-drawer-overlay"
      panelClass="profile-social-drawer"
    >
      <div class="profile-social-shell">
        <header class="profile-social-header">
          <Button
            v-if="socialChatTarget"
            variant="unstyled"
            size="none"
            class="profile-social-icon-btn"
            tooltip="返回列表"
            aria-label="返回列表"
            @click="closeSocialChat"
          >
            <Icon :icon="iconChevronLeft" width="18" height="18" />
          </Button>
          <div class="profile-social-title">
            <span class="profile-social-kicker">{{
              socialChatTarget ? '私信会话' : '个人互动'
            }}</span>
            <h2>{{ socialChatTarget?.nickname || activeSocialTabMeta.label }}</h2>
          </div>
          <div class="profile-social-header-actions">
            <Button
              v-if="!socialChatTarget"
              variant="unstyled"
              size="none"
              class="profile-social-icon-btn"
              tooltip="刷新列表"
              aria-label="刷新列表"
              :disabled="isSocialBusy"
              @click="refreshSocialList"
            >
              <Icon
                :icon="iconRefreshCw"
                width="16"
                height="16"
                :class="isSocialBusy ? 'animate-spin' : ''"
              />
            </Button>
            <Button
              variant="unstyled"
              size="none"
              class="profile-social-icon-btn"
              tooltip="关闭"
              aria-label="关闭"
              @click="socialDrawerOpen = false"
            >
              <Icon :icon="iconX" width="17" height="17" />
            </Button>
          </div>
        </header>

        <template v-if="!socialChatTarget">
          <CustomTabBar
            v-model="activeSocialTabIndex"
            class="profile-social-tabs"
            :tabs="socialTabLabels"
            aria-label="个人互动分类"
          />

          <div class="profile-social-list" :aria-busy="isSocialBusy">
            <div v-if="isSocialBusy && activeSocialUsers.length === 0" class="profile-social-state">
              正在加载{{ activeSocialTabMeta.label }}
            </div>
            <div v-else-if="socialError[activeSocialTab]" class="profile-social-state">
              <p>{{ socialError[activeSocialTab] }}</p>
              <Button variant="outline" size="xs" @click="refreshSocialList">重试</Button>
            </div>
            <div v-else-if="activeSocialUsers.length === 0" class="profile-social-state">
              {{ activeSocialTabMeta.empty }}
            </div>
            <div v-else class="profile-social-users">
              <div v-for="item in activeSocialUsers" :key="item.key" class="profile-social-user">
                <Avatar :src="item.avatar" class="profile-social-avatar" />
                <div class="profile-social-user-main">
                  <div class="profile-social-user-line">
                    <strong>{{ item.nickname }}</strong>
                    <span v-if="item.meta">{{ item.meta }}</span>
                  </div>
                  <p>{{ item.description || `ID ${item.userId || '-'}` }}</p>
                </div>
                <div class="profile-social-user-actions">
                  <Button
                    v-if="item.friendAction"
                    type="button"
                    :variant="item.friendAction === 'follow' ? 'primary' : 'secondary'"
                    size="xs"
                    class="profile-social-follow-btn"
                    :class="{ 'is-unfollow': item.friendAction === 'unfollow' }"
                    :loading="socialFollowPending.has(item.userId)"
                    :disabled="isSocialBusy"
                    @click.stop.prevent="toggleSocialFollow(item)"
                  >
                    <Icon
                      v-if="!socialFollowPending.has(item.userId)"
                      :icon="item.friendAction === 'follow' ? iconPlus : iconMinus"
                      class="profile-social-follow-icon"
                      width="14"
                      height="14"
                    />
                    <span>{{ item.friendAction === 'follow' ? '关注' : '取消关注' }}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    class="profile-social-message-btn"
                    :disabled="!item.canMessage"
                    @click="openSocialChat(item)"
                  >
                    <Icon :icon="iconMessageCircle" width="14" height="14" />
                    <span>私信</span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </template>

        <template v-else>
          <section class="profile-chat-panel">
            <div v-if="socialChatLoading" class="profile-social-state">正在获取私信记录</div>
            <div v-else-if="socialChatMessages.length === 0" class="profile-social-state">
              暂无私信记录
            </div>
            <div v-else class="profile-chat-list">
              <div
                v-for="message in socialChatMessages"
                :key="message.id"
                class="profile-chat-message"
                :class="{ 'is-self': message.isSelf }"
              >
                <Avatar :src="message.avatar" class="profile-chat-avatar" />
                <div class="profile-chat-bubble-wrap">
                  <div class="profile-chat-meta">
                    <strong>{{ message.nickname }}</strong>
                    <time v-if="message.time">{{ message.time }}</time>
                  </div>
                  <div class="profile-chat-bubble">
                    <img
                      v-if="message.imageUrl && message.type === 202"
                      :src="message.imageUrl"
                      alt=""
                    />
                    <span v-else>{{ message.text }}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <form class="profile-chat-composer" @submit.prevent="sendSocialChat">
            <textarea
              v-model="socialChatDraft"
              class="profile-chat-textarea"
              rows="1"
              :disabled="socialChatSending"
              :maxlength="SOCIAL_CHAT_TEXT_LIMIT"
              :aria-invalid="socialChatDraftOverLimit"
              placeholder="发送一条私信"
              aria-label="发送私信"
              @keydown.enter.exact.prevent="sendSocialChat"
            />
            <span class="profile-chat-count" :class="{ 'is-over-limit': socialChatDraftOverLimit }">
              {{ socialChatDraftLength }} / {{ SOCIAL_CHAT_TEXT_LIMIT }}
            </span>
            <Button
              type="submit"
              variant="primary"
              size="xs"
              class="profile-chat-send"
              :loading="socialChatSending"
              :disabled="socialChatDraftOverLimit || !socialChatDraft.trim() || socialChatSending"
              aria-label="发送私信"
            >
              {{ socialChatSending ? '发送中…' : '发送' }}
            </Button>
          </form>
        </template>
      </div>
    </Drawer>

    <Dialog
      v-model:open="showGradeDetail"
      title="我的等级"
      description="每一次聆听，都在积累成长。"
      show-close
      no-scroll
      content-class="profile-grade-dialog"
      description-class="profile-grade-description"
    >
      <p class="profile-grade-description">每一次聆听，都在积累成长。</p>
      <div class="grade-card" :aria-busy="gradeLoading">
        <div class="grade-card-hero">
          <div class="grade-card-copy">
            <p class="grade-card-label">当前等级</p>
            <p class="grade-card-level">
              <RollingNumber :value="`Lv.${gradeProgress.grade ?? '—'}`" />
            </p>
          </div>
          <svg class="grade-planet" viewBox="0 0 128 112" fill="none" aria-hidden="true">
            <!-- 唱片化作星球，轨道前后分层；使用主题色适配明暗外观。 -->
            <ellipse class="grade-planet-halo" cx="64" cy="58" rx="48" ry="45" />
            <path class="grade-planet-orbit" d="M 13 78 C -6 58 93 14 115 34" />
            <circle class="grade-planet-disc" cx="64" cy="56" r="34" />
            <g class="grade-planet-grooves">
              <circle cx="64" cy="56" r="28" />
              <circle cx="64" cy="56" r="23" />
              <circle cx="64" cy="56" r="18" />
            </g>
            <path class="grade-planet-shine" d="M 39 49 A 26 26 0 0 1 59 31" />
            <circle class="grade-planet-label" cx="64" cy="56" r="11" />
            <circle class="grade-planet-hole" cx="64" cy="56" r="3" />
            <path class="grade-planet-orbit" d="M 115 34 C 139 53 34 101 13 78" />
            <circle class="grade-planet-moon" cx="101" cy="65" r="4" />
            <path
              class="grade-planet-star"
              d="M 25 16 L 27 22 L 33 24 L 27 26 L 25 32 L 23 26 L 17 24 L 23 22 Z"
            />
            <path
              class="grade-planet-note"
              d="M 104 15 V 5 L 112 3 V 12 M 104 15 C 104 19 97 19 97 16 C 97 13 104 12 104 15 Z M 112 12 C 112 16 105 16 105 13 C 105 10 112 9 112 12 Z"
            />
            <circle class="grade-planet-star" cx="90" cy="97" r="2" />
            <circle class="grade-planet-star" cx="13" cy="48" r="1.5" />
          </svg>
        </div>
        <template v-if="gradeProgress.available">
          <div class="grade-progress-meta">
            <span class="grade-progress-hint"
              >距 Lv.{{ gradeProgress.nextGrade }} 还差
              <RollingNumber
                class="font-semibold"
                :value="gradeProgress.remaining?.toLocaleString() ?? '—'"
              />
              经验</span
            >
            <span class="grade-progress-nums"
              ><RollingNumber :value="gradeProgress.current?.toLocaleString() ?? '—'" /> /
              <RollingNumber :value="gradeProgress.target?.toLocaleString() ?? '—'"
            /></span>
          </div>
          <div
            class="grade-progress-track"
            role="progressbar"
            aria-label="等级经验进度"
            :aria-valuenow="
              gradeProgress.current === null
                ? 0
                : Math.min(gradeProgress.current, gradeProgress.target ?? 0)
            "
            :aria-valuemin="0"
            :aria-valuemax="gradeProgress.target ?? 100"
          >
            <div class="grade-progress-fill" :style="{ width: `${gradeProgress.percent}%` }"></div>
          </div>
        </template>
        <p v-else class="grade-progress-empty" role="status">
          {{ gradeLoading ? '正在获取升级进度…' : '暂未获取到下一等级进度，请稍后刷新' }}
        </p>
      </div>
      <div class="grade-listen-row">
        <span>累计听歌</span>
        <RollingNumber :value="listeningDuration" />
      </div>
      <template #footer>
        <Button
          variant="outline"
          size="sm"
          :loading="gradeLoading"
          :disabled="gradeLoading"
          @click="openGradeDetail"
          >刷新进度</Button
        >
        <Button size="sm" @click="showGradeDetail = false">继续听歌</Button>
      </template>
    </Dialog>

    <Dialog
      v-model:open="showDeviceManager"
      title="登录设备管理"
      contentClass="login-device-dialog"
      :showClose="true"
    >
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-[13px] font-bold text-text-main">{{ loginDeviceSummary }}</p>
          </div>
          <Button
            variant="unstyled"
            size="none"
            class="w-8 h-8 rounded-full flex items-center justify-center text-[var(--icon-main)] hover:bg-[var(--control-hover-bg)] hover:text-text-main"
            tooltip="刷新登录设备"
            aria-label="刷新登录设备"
            :disabled="loginDeviceStore.loading"
            @click="refreshLoginDevices"
          >
            <Icon
              :icon="iconRefreshCw"
              width="15"
              height="15"
              :class="loginDeviceStore.loading ? 'animate-spin' : ''"
            />
          </Button>
        </div>

        <div v-if="loginDeviceStore.error" class="text-[12px] font-bold text-red-500">
          {{ loginDeviceStore.error }}
        </div>

        <div
          v-if="loginDeviceStore.loading && loginDevices.length === 0"
          class="py-10 text-center text-[13px] text-text-secondary font-bold"
        >
          正在获取登录设备
        </div>
        <div
          v-else-if="loginDevices.length === 0"
          class="py-10 text-center text-[13px] text-text-secondary font-bold"
        >
          暂无登录设备记录
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="device in loginDevices"
            :key="device.id"
            class="login-device-row flex items-center gap-3 p-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--control-muted-bg)]"
          >
            <div
              :class="[
                'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                device.isCurrent
                  ? 'bg-primary/15 text-primary-text'
                  : 'bg-[var(--control-hover-bg)]',
              ]"
            >
              <Icon :icon="iconSmartphone" width="20" height="20" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[13px] font-black truncate">{{ device.title }}</span>
                <span
                  v-if="device.isCurrent"
                  class="px-1.5 py-0.5 rounded-md bg-primary/12 text-primary-text text-[10px] font-black shrink-0"
                  >本机</span
                >
                <span
                  v-if="device.isNew && !device.isCurrent"
                  class="px-1.5 py-0.5 rounded-md bg-green-500/12 text-green-500 text-[10px] font-black shrink-0"
                  >新设备</span
                >
              </div>
              <p class="text-[11px] text-text-secondary font-bold truncate">
                {{ formatDeviceDetailLine(device) }}
              </p>
              <p class="text-[11px] text-text-secondary font-bold truncate">
                {{ formatDeviceActivityLine(device) }}
              </p>
            </div>
            <Button
              v-if="!device.isCurrent"
              variant="ghost"
              size="xs"
              :disabled="!device.canKick"
              :loading="loginDeviceStore.kickingId === device.id"
              class="shrink-0 text-red-500/80 hover:bg-red-500/10 hover:text-red-500"
              @click="requestKickDevice(device)"
            >
              <span>移除</span>
            </Button>
          </div>
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:open="showKickConfirm"
      title="移除登录设备"
      :description="`移除“${pendingKickDevice?.title || '该设备'}”后，该设备需要重新登录。`"
    >
      <template #footer>
        <Button variant="outline" size="sm" @click="showKickConfirm = false">取消</Button>
        <Button
          variant="danger"
          size="sm"
          :loading="
            Boolean(pendingKickDevice && loginDeviceStore.kickingId === pendingKickDevice.id)
          "
          @click="confirmKickDevice"
        >
          确认移除
        </Button>
      </template>
    </Dialog>
  </PageScrollContainer>
</template>

<style scoped>
.profile-stats {
  display: flex;
  align-items: stretch;
  flex-wrap: wrap;
  gap: 24px;
}
.profile-stat {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 0;
}
.profile-stat + .profile-stat {
  padding-left: 24px;
}
.profile-stat + .profile-stat::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  height: 16px;
  width: 1px;
  transform: translateY(-50%);
  background: var(--border-subtle);
}
.profile-stat-value {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  font-size: 15px;
  font-weight: 900;
  line-height: 1.25;
}
.profile-stat-label {
  font-size: 10px;
  font-weight: 700;
  line-height: 14px;
  letter-spacing: 0.05em;
  white-space: nowrap;
  color: var(--color-text-secondary);
}
.grade-entry {
  border-radius: 8px;
  cursor: pointer;
  transition: color 160ms;
}
.grade-entry:hover {
  color: var(--color-primary-text);
}
.grade-entry:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 5px;
}
.profile-social-stat {
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition:
    color 160ms,
    opacity 160ms;
}
.profile-social-stat:hover {
  color: var(--color-primary-text);
}
.profile-social-stat:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 5px;
}
:global(.profile-social-drawer-overlay) {
  background: var(--surface-scrim-bg);
}
:global(.drawer-panel.profile-social-drawer) {
  top: var(--drawer-safe-top);
  right: 12px;
  bottom: var(--drawer-safe-bottom);
  width: min(460px, calc(100vw - 24px));
  border-radius: 12px;
  box-shadow: var(--shadow-dialog);
  overflow: hidden;
}
@media (max-width: 420px) {
  :global(.drawer-panel.profile-social-drawer) {
    --drawer-top-gap: 4px;
    --drawer-bottom-gap: 8px;
    right: 8px;
    width: min(460px, calc(100vw - 16px));
  }
}
.profile-social-shell {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
}
.profile-social-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 12px;
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.profile-social-title {
  min-width: 0;
  flex: 1;
}
.profile-social-kicker {
  display: block;
  margin-bottom: 2px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 700;
}
.profile-social-title h2 {
  overflow: hidden;
  color: var(--color-text-main);
  font-size: 18px;
  font-weight: 900;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-social-header-actions {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}
.profile-social-icon-btn {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--icon-main);
  transition:
    background-color 160ms,
    color 160ms;
}
.profile-social-icon-btn:hover {
  background: var(--control-hover-bg);
  color: var(--color-text-main);
}
.profile-social-tabs {
  flex-shrink: 0;
  width: calc(100% - 28px);
  margin: 12px 14px;
}
.profile-social-list,
.profile-chat-panel {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 4px 12px 12px;
}
.profile-social-state {
  display: grid;
  min-height: 180px;
  place-items: center;
  gap: 10px;
  padding: 24px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
  text-align: center;
}
.profile-social-state p {
  max-width: 280px;
}
.profile-social-users {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
.profile-social-user {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--control-muted-bg);
}
.profile-social-avatar {
  width: 42px;
  height: 42px;
  border-radius: 999px;
}
.profile-social-user-main {
  min-width: 0;
  flex: 1;
}
.profile-social-user-line {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
}
.profile-social-user-line strong {
  overflow: hidden;
  color: var(--color-text-main);
  font-size: 13px;
  font-weight: 900;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-social-user-line span {
  flex-shrink: 0;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 700;
}
.profile-social-user-main p {
  overflow: hidden;
  margin-top: 3px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-social-user-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
}
.profile-social-follow-btn {
  width: 96px;
  height: 32px;
  flex-shrink: 0;
  padding: 0 10px;
  border-radius: 8px;
  font-weight: 700;
  white-space: nowrap;
}
.profile-social-follow-btn.is-unfollow {
  color: var(--color-text-secondary);
}
.profile-social-follow-btn.is-unfollow:hover:not(:disabled) {
  color: var(--color-text-main);
}
.profile-social-follow-icon {
  flex-shrink: 0;
  margin-right: 6px;
}
.profile-social-message-btn {
  flex-shrink: 0;
  gap: 5px;
}
.profile-chat-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px 12px;
}
.profile-chat-message {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}
.profile-chat-message.is-self {
  flex-direction: row-reverse;
}
.profile-chat-avatar {
  width: 30px;
  height: 30px;
  border-radius: 999px;
}
.profile-chat-bubble-wrap {
  min-width: 0;
  max-width: 76%;
}
.profile-chat-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
}
.profile-chat-message.is-self .profile-chat-meta {
  justify-content: flex-end;
}
.profile-chat-meta strong {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-chat-meta time {
  color: var(--color-text-secondary);
  font-size: 9px;
  font-weight: 700;
}
.profile-chat-bubble {
  overflow: hidden;
  padding: 9px 11px;
  border-radius: 6px 14px 14px;
  background: var(--control-muted-bg);
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 650;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.profile-chat-message.is-self .profile-chat-bubble {
  border-radius: 14px 6px 14px 14px;
  background: var(--color-primary);
  color: var(--color-on-primary);
}
.profile-chat-bubble img {
  display: block;
  max-width: 180px;
  max-height: 220px;
  border-radius: 8px;
  object-fit: contain;
}
.profile-chat-composer {
  display: flex;
  flex-shrink: 0;
  align-items: flex-end;
  gap: 12px;
  margin: 10px 12px 12px;
  padding: 10px 12px;
  border: 1px solid var(--control-border);
  border-radius: 14px;
  background: var(--color-bg-elevated);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.045);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.profile-chat-composer:focus-within {
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--control-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 8%, transparent);
}
.profile-chat-textarea {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  min-height: 32px;
  max-height: 112px;
  padding: 6px 4px;
  resize: none;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-main);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  field-sizing: content;
  user-select: text;
}
.profile-chat-textarea::placeholder {
  color: var(--color-text-secondary);
  opacity: 1;
}
.profile-chat-count {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.profile-chat-count.is-over-limit {
  color: var(--color-danger);
}
.profile-chat-send {
  display: inline-flex;
  min-width: 60px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  font-weight: 600;
}
.grade-card {
  min-height: 176px;
  padding: 22px 20px 18px;
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  overflow: hidden;
  background: linear-gradient(
    135deg,
    rgba(var(--color-primary-rgb), 0.14),
    rgba(var(--color-primary-rgb), 0.03)
  );
}
.grade-card-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.grade-card-copy {
  min-width: 0;
  flex: 1 1 auto;
}
.grade-card-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--color-text-secondary);
}
.grade-card-level {
  margin-top: 4px;
  min-height: 34px;
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.1;
}
.grade-planet {
  width: 88px;
  height: 76px;
  flex-shrink: 0;
  color: var(--color-primary-text);
}
.grade-planet-halo {
  fill: rgba(var(--color-primary-rgb), 0.06);
}
.grade-planet-disc {
  fill: var(--color-primary-text);
  stroke: rgba(var(--color-primary-rgb), 0.3);
  stroke-width: 2;
}
.grade-planet-grooves {
  stroke: var(--color-bg-main);
  stroke-opacity: 0.22;
}
.grade-planet-shine {
  stroke: white;
  stroke-opacity: 0.55;
  stroke-width: 2;
  stroke-linecap: round;
}
.grade-planet-label {
  fill: var(--color-primary);
}
.grade-planet-hole {
  fill: var(--color-bg-main);
}
.grade-planet-orbit {
  stroke: var(--color-primary);
  stroke-width: 2;
  stroke-linecap: round;
}
.grade-planet-moon {
  fill: var(--color-primary);
  stroke: var(--color-bg-main);
  stroke-width: 2;
}
.grade-planet-star {
  fill: currentColor;
  opacity: 0.65;
}
.grade-planet-note {
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linejoin: round;
}
@media (max-width: 420px) {
  .grade-planet {
    width: 72px;
    height: 62px;
  }
}
.grade-progress-meta {
  display: flex;
  flex-wrap: nowrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin: 18px 0 8px;
  font-size: 12px;
  line-height: 1.4;
}
.grade-progress-hint {
  min-width: 0;
  flex: 1 1 auto;
  white-space: nowrap;
}
.grade-progress-nums {
  flex: 0 0 auto;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.grade-progress-empty {
  margin-top: 16px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.grade-progress-track {
  height: 5px;
  overflow: hidden;
  border-radius: 99px;
  background: var(--border-subtle);
}
.grade-listen-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 16px 2px 4px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.grade-listen-row :deep(.rolling-number) {
  font-weight: 700;
  color: var(--color-text-main);
}
.grade-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
}
.user-card {
  box-shadow: 0 20px 60px -10px rgba(var(--color-primary-rgb), 0.15);
}

.profile-ip-location {
  position: absolute;
  top: 14px;
  right: 16px;
  z-index: 11;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-primary-text);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 20%, transparent);
  pointer-events: none;
}

.profile-avatar-button:disabled {
  cursor: wait;
}

.profile-editor-form {
  display: grid;
  gap: 16px;
}

.profile-editor-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.profile-editor-field {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.profile-editor-field > span {
  font-size: 12px;
  font-weight: 800;
  color: var(--color-text-secondary);
}

.profile-editor-field > small {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.profile-archive-card {
  background-color: var(--content-panel-bg) !important;
  border-color: var(--content-panel-border) !important;
  box-shadow: var(--shadow-card) !important;
}

.login-device-row {
  min-height: 76px;
}

.profile-info-grid {
  display: grid;
  gap: 24px;
  grid-template-columns: minmax(0, 1fr);
}

@media (min-width: 768px) {
  .profile-info-grid {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  }
}
</style>

<style>
.dialog-content.profile-grade-dialog {
  width: min(400px, 92vw);
  max-height: min(720px, calc(100vh - 108px));
  padding-top: 26px;
  padding-bottom: 28px;
  overflow: hidden;
}
.dialog-content.profile-grade-dialog .dialog-title {
  font-size: 16px;
}
.dialog-content.profile-grade-dialog .profile-grade-description {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}
.dialog-content.profile-grade-dialog .dialog-body {
  overflow: hidden;
}
.dialog-content.profile-grade-dialog .rolling-number {
  display: inline-block;
  font-variant-numeric: tabular-nums;
}
.vip-expire-popover.echo-popover-content {
  padding: 12px 14px;
  border-color: var(--border-subtle);
}

.dialog-content.login-device-dialog {
  width: min(480px, 92vw);
  max-height: min(720px, calc(100vh - 140px));
}

.dialog-content.profile-editor-dialog {
  width: min(520px, 92vw);
  max-height: min(760px, calc(100vh - 100px));
}

.profile-editor-dialog .profile-editor-field .relative > input,
.profile-editor-dialog .echo-select-trigger {
  height: 44px;
  min-height: 44px;
  border-color: var(--control-border);
  border-radius: 12px;
  padding-left: 14px;
  font-size: 13px;
}

.profile-editor-dialog .profile-editor-select,
.profile-editor-dialog .profile-editor-select > span,
.profile-editor-dialog .profile-editor-select-trigger {
  width: 100%;
}

.profile-editor-dialog .profile-editor-signature {
  min-height: 84px;
}
</style>
