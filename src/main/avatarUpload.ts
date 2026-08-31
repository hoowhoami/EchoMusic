export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_AVATAR_BYTES / 3) * 4;
const MAX_BASE64_INPUT_CHARS = MAX_BASE64_CHARS + 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const getAvatarExtension = (image: Buffer) => {
  if (image[0] === 0xff && image[1] === 0xd8) return 'jpg';
  if (image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47) {
    return 'png';
  }
  if (image[0] === 0x47 && image[1] === 0x49 && image[2] === 0x46) return 'gif';
  return '';
};

const normalizeAvatarImage = (input: unknown): Buffer | null => {
  if (Buffer.isBuffer(input)) {
    return input.length <= MAX_AVATAR_BYTES && getAvatarExtension(input) ? input : null;
  }
  if (typeof input !== 'string' || !input || input.length > MAX_BASE64_INPUT_CHARS) return null;
  const comma = input.startsWith('data:') ? input.indexOf(',') : -1;
  if (input.startsWith('data:') && comma < 0) return null;
  const base64 = (comma >= 0 ? input.slice(comma + 1) : input).replace(/\s/g, '');
  if (
    !base64 ||
    base64.length > MAX_BASE64_CHARS ||
    base64.length % 4 !== 0 ||
    !BASE64_RE.test(base64)
  ) {
    return null;
  }
  const image = Buffer.from(base64, 'base64');
  return image.length <= MAX_AVATAR_BYTES && getAvatarExtension(image) ? image : null;
};

export const prepareAvatarUploadQuery = (query: Record<string, unknown>) => {
  const image = normalizeAvatarImage(query.imgFile ?? query.img ?? query.file);
  const extension = image ? getAvatarExtension(image) : '';
  if (!image || !extension) {
    throw new Error('图片数据无效（最大 8 MB，仅支持 JPEG/PNG/GIF）');
  }
  query.imgFile = image;
  query.filename = `avatar.${extension}`;
  return query;
};
