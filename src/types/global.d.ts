import { DialogApi, LoadingBarApi, MessageApi, ModalApi, NotificationApi } from 'naive-ui';

declare global {
  interface Window {
    $dialog: DialogApi;
    $loadingBar: LoadingBarApi;
    $message: MessageApi;
    $modal: ModalApi;
    $notification: NotificationApi;
  }
}
