//! Windows 任务栏 iconic 缩略图（DWM）支持。
//!
//! 通过 DWM 的 iconic representation 机制，把任务栏悬停预览替换为歌曲封面：
//! - 播放时开启 `DWMWA_FORCE_ICONIC_REPRESENTATION` + `DWMWA_HAS_ICONIC_BITMAP`，
//!   系统会发送 `WM_DWMSENDICONICTHUMBNAIL` / `WM_DWMSENDICONICLIVEPREVIEWBITMAP`，
//!   届时由主进程回调本模块写入封面位图；
//! - 暂停/停止时关闭上述属性并 invalidate，预览回退为窗口实时画面。
//!
//! 窗口消息的钩子在主进程（Electron `hookWindowMessage`）中完成，本模块只负责
//! 「构建位图 + 调用 DWM API」，与 SMTC 逻辑完全解耦。

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{
    DwmInvalidateIconicBitmaps, DwmSetIconicLivePreviewBitmap, DwmSetIconicThumbnail,
    DwmSetWindowAttribute, DWMWA_FORCE_ICONIC_REPRESENTATION, DWMWA_HAS_ICONIC_BITMAP,
};
use windows::Win32::Graphics::Gdi::{
    CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};

/// DwmSetIconicThumbnail / LivePreview 的标志：绘制带边框的窗口帧
const DWM_SIT_DISPLAYFRAME: u32 = 0x0000_0001;

/// 将 JS 传入的窗口句柄字符串（无符号十进制指针值）解析为 HWND
fn parse_hwnd(hwnd: &str) -> Option<HWND> {
    hwnd.trim()
        .parse::<usize>()
        .ok()
        .map(|v| HWND(v as *mut core::ffi::c_void))
}

/// 设置 / 取消窗口的 iconic 表示属性
fn set_iconic_flags(hwnd: HWND, enable: bool) -> Result<(), String> {
    let flag: i32 = if enable { 1 } else { 0 };
    let ptr = &flag as *const i32 as *const core::ffi::c_void;
    unsafe {
        DwmSetWindowAttribute(hwnd, DWMWA_HAS_ICONIC_BITMAP, ptr, 4)
            .map_err(|e| format!("DwmSetWindowAttribute(HAS_ICONIC_BITMAP) failed: {e}"))?;
        DwmSetWindowAttribute(hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, ptr, 4)
            .map_err(|e| format!("DwmSetWindowAttribute(FORCE_ICONIC_REPRESENTATION) failed: {e}"))?;
    }
    Ok(())
}

/// 创建 32bpp top-down DIB（origin 在左上角），返回位图句柄与像素缓冲指针。
/// 调用方负责在使用完后 `DeleteObject`。
unsafe fn create_dib(width: i32, height: i32) -> Result<(HBITMAP, *mut u8), String> {
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = core::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width;
    // 负高度 = top-down DIB，与图片像素行序一致
    bmi.bmiHeader.biHeight = -height;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0; // BI_RGB

    let mut bits: *mut core::ffi::c_void = core::ptr::null_mut();
    let hbmp = CreateDIBSection(None, &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
        .map_err(|e| format!("CreateDIBSection failed: {e}"))?;
    if bits.is_null() {
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        return Err("CreateDIBSection returned null bit buffer".into());
    }
    Ok((hbmp, bits as *mut u8))
}

/// 解码图片并等比缩放到 `max_w x max_h` 框内，返回 RGBA 像素与实际尺寸。
fn decode_scaled(data: &[u8], max_w: u32, max_h: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let img = image::load_from_memory(data).map_err(|e| format!("decode image failed: {e}"))?;
    let max_w = max_w.max(1);
    let max_h = max_h.max(1);
    // resize 等比缩放使图片完整落入框内
    let scaled = img.resize(max_w, max_h, image::imageops::FilterType::Lanczos3);
    let rgba = scaled.to_rgba8();
    let (w, h) = rgba.dimensions();
    Ok((rgba.into_raw(), w, h))
}

/// 将 RGBA 像素写入 DIB（GDI 需要 BGRA 排列）。
unsafe fn fill_dib_bgra(bits: *mut u8, rgba: &[u8], w: u32, h: u32) {
    let pixel_count = (w as usize) * (h as usize);
    for i in 0..pixel_count {
        let s = i * 4;
        let d = i * 4;
        *bits.add(d) = rgba[s + 2]; // B
        *bits.add(d + 1) = rgba[s + 1]; // G
        *bits.add(d + 2) = rgba[s]; // R
        *bits.add(d + 3) = rgba[s + 3]; // A
    }
}

/// 解码封面 → 构建 DIB → 交给指定的 DWM setter，统一处理资源释放。
fn render_and_apply<F>(
    hwnd: HWND,
    data: &[u8],
    max_w: u32,
    max_h: u32,
    apply: F,
) -> Result<(), String>
where
    F: FnOnce(HWND, HBITMAP) -> Result<(), String>,
{
    let (rgba, w, h) = decode_scaled(data, max_w, max_h)?;
    unsafe {
        let (hbmp, bits) = create_dib(w as i32, h as i32)?;
        fill_dib_bgra(bits, &rgba, w, h);
        let result = apply(hwnd, hbmp);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        result
    }
}

// --- NAPI 导出 ---

/// 开启窗口的 iconic 表示（播放时调用，使任务栏悬停预览改用封面）
#[napi]
pub fn taskbar_enable_iconic(hwnd: String) -> napi::Result<()> {
    let hwnd = parse_hwnd(&hwnd).ok_or_else(|| napi::Error::from_reason("invalid hwnd"))?;
    set_iconic_flags(hwnd, true).map_err(napi::Error::from_reason)
}

/// 关闭窗口的 iconic 表示（暂停/停止时调用，预览回退为窗口实时画面）
#[napi]
pub fn taskbar_disable_iconic(hwnd: String) -> napi::Result<()> {
    let hwnd = parse_hwnd(&hwnd).ok_or_else(|| napi::Error::from_reason("invalid hwnd"))?;
    set_iconic_flags(hwnd, false).map_err(napi::Error::from_reason)
}

/// 请求系统重新索取缩略图/预览位图（封面切换或开启 iconic 后调用）
#[napi]
pub fn taskbar_invalidate(hwnd: String) -> napi::Result<()> {
    let hwnd = parse_hwnd(&hwnd).ok_or_else(|| napi::Error::from_reason("invalid hwnd"))?;
    unsafe {
        DwmInvalidateIconicBitmaps(hwnd)
            .map_err(|e| napi::Error::from_reason(format!("DwmInvalidateIconicBitmaps failed: {e}")))
    }
}

/// 响应 WM_DWMSENDICONICTHUMBNAIL：写入封面作为悬停缩略图。
/// `max_width` / `max_height` 来自消息 lParam 指定的最大尺寸。
#[napi]
pub fn taskbar_set_thumbnail(
    hwnd: String,
    image: Buffer,
    max_width: u32,
    max_height: u32,
) -> napi::Result<()> {
    let hwnd = parse_hwnd(&hwnd).ok_or_else(|| napi::Error::from_reason("invalid hwnd"))?;
    render_and_apply(hwnd, image.as_ref(), max_width, max_height, |hwnd, hbmp| unsafe {
        DwmSetIconicThumbnail(hwnd, hbmp, DWM_SIT_DISPLAYFRAME)
            .map_err(|e| format!("DwmSetIconicThumbnail failed: {e}"))
    })
    .map_err(napi::Error::from_reason)
}

/// 响应 WM_DWMSENDICONICLIVEPREVIEWBITMAP：写入封面作为 Aero Peek 大预览。
#[napi]
pub fn taskbar_set_live_preview(
    hwnd: String,
    image: Buffer,
    max_width: u32,
    max_height: u32,
) -> napi::Result<()> {
    let hwnd = parse_hwnd(&hwnd).ok_or_else(|| napi::Error::from_reason("invalid hwnd"))?;
    render_and_apply(hwnd, image.as_ref(), max_width, max_height, |hwnd, hbmp| unsafe {
        DwmSetIconicLivePreviewBitmap(hwnd, hbmp, None, DWM_SIT_DISPLAYFRAME)
            .map_err(|e| format!("DwmSetIconicLivePreviewBitmap failed: {e}"))
    })
    .map_err(napi::Error::from_reason)
}
