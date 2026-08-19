import request from '@/utils/request';

export interface NativeImportTask {
  id: string | number;
  userid?: string | number;
  listid?: string | number;
  source?: number;
  task_type?: number;
  type?: number;
  status: number;
  name?: string;
  url?: string;
  songs_num?: number;
  imported_num?: number;
  missed_num?: number;
  matched_num?: number;
  msg?: string;
  pic?: string;
  gid?: string;
}

export interface NativeImportMissedTrack {
  album_name?: string;
  audio_name?: string;
  author_name?: string;
  reason?: string;
  out_id?: string | number;
}

export interface NativeImportTaskResult extends NativeImportTask {
  missed?: NativeImportMissedTrack[];
}

const postImport = (data: Record<string, unknown>) =>
  request.post('/import/playlist', data, { params: { timestamp: Date.now() } });

export function createLinkImportTask(url: string) {
  return postImport({
    operation: 'add_task',
    task_type: 0,
    url,
  });
}

export function submitImportScreenshot(taskSn: string, imgBase64: string) {
  return postImport({
    operation: 'submit_img',
    task_sn: taskSn,
    img_base64: imgBase64,
  });
}

export function createScreenshotImportTask(
  taskSn: string,
  listid: string | number,
  listName: string,
) {
  return postImport({
    operation: 'add_task',
    task_type: 1,
    task_sn: taskSn,
    listid,
    list_name: listName,
  });
}

export function getImportTaskStatuses(ids: Array<string | number>) {
  return postImport({
    operation: 'query_task_status',
    ids,
  });
}

export function getImportTaskResult(listid: string | number, page = 1, pagesize = 30) {
  return postImport({
    operation: 'query_task',
    listid,
    page,
    pagesize,
    show_missed: 1,
  });
}

export function getImportTaskCount() {
  return postImport({
    operation: 'task_count',
    classify: 1,
  });
}
