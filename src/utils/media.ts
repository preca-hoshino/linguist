/**
 * 从 MIME 类型推断内部媒体类型
 */
export function mimeToMediaType(mimeType: string): 'image' | 'audio' | 'video' | 'file' {
  const prefix = mimeType.split('/')[0];
  if (prefix === 'image') {
    return 'image';
  }
  if (prefix === 'audio') {
    return 'audio';
  }
  if (prefix === 'video') {
    return 'video';
  }
  return 'file';
}
