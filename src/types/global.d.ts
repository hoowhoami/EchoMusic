import { Howl } from 'howler';
import { DialogApi, LoadingBarApi, MessageApi, ModalApi, NotificationApi } from 'naive-ui';

declare global {
  interface Window {
    player?: null | Howl;
    $dialog: DialogApi;
    $loadingBar: LoadingBarApi;
    $message: MessageApi;
    $modal: ModalApi;
    $notification: NotificationApi;
    require?: any;
  }
}
