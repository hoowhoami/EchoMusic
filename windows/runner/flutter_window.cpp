#include "flutter_window.h"

#include <optional>
#include <string>

// For WASAPI default device query.
#include <mmdeviceapi.h>
#include <windows.h>

#include "flutter/generated_plugin_registrant.h"

// ---------------------------------------------------------------------------
// Helper: query the WASAPI default audio render endpoint and return its
// MMDevice ID string (UTF-8).  This ID is identical to what libmpv uses as
// AudioDevice.name on Windows, so callers can match it against the list that
// media_kit surfaces from Player.state.audioDevices.
// ---------------------------------------------------------------------------
static std::string GetDefaultAudioOutputDeviceId() {
  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = ::CoCreateInstance(
      __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
      __uuidof(IMMDeviceEnumerator),
      reinterpret_cast<void**>(&enumerator));
  if (FAILED(hr) || !enumerator) return {};

  IMMDevice* device = nullptr;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  enumerator->Release();
  if (FAILED(hr) || !device) return {};

  LPWSTR device_id = nullptr;
  hr = device->GetId(&device_id);
  device->Release();
  if (FAILED(hr) || !device_id) return {};

  // Convert the wide-char ID to UTF-8.
  int len = ::WideCharToMultiByte(CP_UTF8, 0, device_id, -1,
                                   nullptr, 0, nullptr, nullptr);
  std::string result(len, '\0');
  ::WideCharToMultiByte(CP_UTF8, 0, device_id, -1,
                        result.data(), len, nullptr, nullptr);
  ::CoTaskMemFree(device_id);
  // Strip the trailing null WideCharToMultiByte includes.
  if (!result.empty() && result.back() == '\0') result.pop_back();
  return result;
}

// ---------------------------------------------------------------------------

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  // Register the native audio-device channel so Dart can resolve the
  // "auto" placeholder to the actual Windows default audio endpoint.
  audio_device_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(),
          "com.hoowhoami.echomusic/audio_device",
          &flutter::StandardMethodCodec::GetInstance());

  audio_device_channel_->SetMethodCallHandler(
      [](const flutter::MethodCall<flutter::EncodableValue>& call,
         std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
             result) {
        if (call.method_name() == "getDefaultOutputDeviceId") {
          auto id = GetDefaultAudioOutputDeviceId();
          if (id.empty()) {
            result->Success(flutter::EncodableValue());
          } else {
            result->Success(flutter::EncodableValue(id));
          }
        } else {
          result->NotImplemented();
        }
      });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
