export interface PluginResourceError {
  code: string;
  message: string;
  retryable?: boolean;
}
export type PluginResourceResult<T> =
  { ok: true; value: T } | { ok: false; error: PluginResourceError };
export interface DirectoryRef {
  id: string;
  name: string;
  access: 'read' | 'read-write';
  kind: 'user' | 'data' | 'cache';
  available: boolean;
  displayPath?: string;
}
export type FileRef =
  | { kind: 'directory-file'; directoryId: string; relativePath: string }
  | { kind: 'selected-file'; fileId: string };
export interface DownloadTarget {
  directoryId: string;
  relativePath: string;
}
export interface DirectoryRequest {
  access: 'read' | 'read-write';
  purpose: string;
  persist?: boolean;
}
export interface FilesRequest {
  purpose: string;
  persist?: boolean;
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}
export interface FileStat {
  file: FileRef;
  name: string;
  size: number;
  modifiedAt: number;
  directory: boolean;
}
export interface FileGrantInfo extends Omit<DirectoryRef, 'kind'> {
  kind: DirectoryRef['kind'] | 'file';
  revoked: boolean;
}
export interface PluginFileGrantGroup {
  pluginId: string;
  pluginName: string;
  grants: FileGrantInfo[];
}
export type PluginGrantManagementAction = 'revoke' | 'remove' | 'reauthorize';
export interface MediaLease {
  id: string;
  url: string;
}
export type ResourceMethod =
  | 'requestDirectory'
  | 'requestFiles'
  | 'listDirectoryGrants'
  | 'reauthorizeDirectoryGrant'
  | 'revokeDirectoryGrant'
  | 'revokeFileGrant'
  | 'getPrivateDirectory'
  | 'stat'
  | 'mkdir'
  | 'listFiles'
  | 'readTextFile'
  | 'readFileBytes'
  | 'readAudioMetadata'
  | 'writeFile'
  | 'deleteFile'
  | 'copyFile'
  | 'openMedia'
  | 'releaseMedia'
  | 'download'
  | 'downloadList'
  | 'downloadGet'
  | 'downloadPause'
  | 'downloadResume'
  | 'downloadRetry'
  | 'downloadCancel'
  | 'downloadRemove';
export interface PluginResourcesNativeApi {
  call<T>(
    pluginId: string,
    method: ResourceMethod,
    input: unknown,
    contextId: string,
  ): Promise<PluginResourceResult<T>>;
  onDownload(
    pluginId: string,
    callback: (snapshot: import('./pluginDownloads').DownloadSnapshot) => void,
    contextId: string,
  ): () => void;
}
