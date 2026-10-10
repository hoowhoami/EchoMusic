//! DWM 请求在窗口线程直接应答；解码只发生在封面变更时。
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::{cell::RefCell, ffi::c_void, rc::Rc};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    Graphics::{
        Dwm::{
            DwmInvalidateIconicBitmaps, DwmSetIconicLivePreviewBitmap, DwmSetIconicThumbnail,
            DwmSetWindowAttribute, DWMWA_FORCE_ICONIC_REPRESENTATION, DWMWA_HAS_ICONIC_BITMAP,
            DWMWINDOWATTRIBUTE,
        },
        Gdi::{
            CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP,
            HGDIOBJ,
        },
    },
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{IsWindow, WM_NCDESTROY},
    },
};
const SUBCLASS_ID: usize = 0x4543484f;
const THUMBNAIL: u32 = 0x0323;
const PEEK: u32 = 0x0326;
const MAX_SIZE: u32 = 600;

struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0 .0));
        }
    }
}
struct Cover {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}
struct CachedBitmap {
    bounds: (u32, u32),
    bitmap: Rc<Bitmap>,
}
struct State {
    hwnd: HWND,
    cover: Option<Cover>,
    thumbnail: Option<CachedBitmap>,
    preview: Option<CachedBitmap>,
}
thread_local! { static STATE: RefCell<Option<State>> = const { RefCell::new(None) }; }

fn parse_handle(value: &str) -> napi::Result<HWND> {
    let ptr = value
        .parse::<usize>()
        .map_err(|_| napi::Error::from_reason("Invalid window handle"))?;
    let hwnd = HWND(ptr as *mut c_void);
    if ptr == 0 || !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err(napi::Error::from_reason("Window no longer exists"));
    }
    Ok(hwnd)
}
unsafe fn flag(hwnd: HWND, attr: DWMWINDOWATTRIBUTE, enabled: bool) -> windows::core::Result<()> {
    let value = i32::from(enabled);
    DwmSetWindowAttribute(
        hwnd,
        attr,
        std::ptr::addr_of!(value).cast(),
        size_of::<i32>() as u32,
    )
}
fn create_bitmap(cover: &Cover, bounds: (u32, u32)) -> windows::core::Result<Bitmap> {
    let (width, height) =
        super::geometry::fit_bitmap(cover.width, cover.height, bounds.0, bounds.1)
            .ok_or_else(|| {
                windows::core::Error::new(
                    windows::core::HRESULT(0x80070057u32 as i32),
                    "Invalid bitmap dimensions",
                )
            })?;
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width as i32,
        biHeight: -(height as i32),
        biPlanes: 1,
        biBitCount: 32,
        ..Default::default()
    };
    let mut pixels = std::ptr::null_mut();
    let bitmap =
        Bitmap(unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut pixels, None, 0)? });
    if pixels.is_null() {
        return Err(windows::core::Error::from_thread());
    }
    let dest =
        unsafe { std::slice::from_raw_parts_mut(pixels as *mut u8, (width * height * 4) as usize) };
    // 小图使用双线性采样；缓存只保留最近的缩略图尺寸和 Peek 尺寸。
    for y in 0..height {
        for x in 0..width {
            let sx = ((x as f64 + 0.5) * cover.width as f64 / width as f64 - 0.5).max(0.0);
            let sy = ((y as f64 + 0.5) * cover.height as f64 / height as f64 - 0.5).max(0.0);
            let x0 = sx.floor() as u32;
            let y0 = sy.floor() as u32;
            let x1 = (x0 + 1).min(cover.width - 1);
            let y1 = (y0 + 1).min(cover.height - 1);
            for c in 0..4 {
                let sample = |px: u32, py: u32| {
                    cover.bytes[((py * cover.width + px) * 4 + c) as usize] as f64
                };
                let wx = sx.fract();
                let wy = sy.fract();
                let top = sample(x0, y0) * (1.0 - wx) + sample(x1, y0) * wx;
                let bottom = sample(x0, y1) * (1.0 - wx) + sample(x1, y1) * wx;
                dest[((y * width + x) * 4 + c) as usize] =
                    (top * (1.0 - wy) + bottom * wy).round() as u8;
            }
        }
    }
    Ok(bitmap)
}
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    w: WPARAM,
    l: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        STATE.with(|slot| {
            slot.borrow_mut().take();
        });
        let _ = RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID);
    } else if msg == THUMBNAIL || msg == PEEK {
        // 不在 DWM 调用期间持有 RefCell 借用，防止同步窗口消息重入。
        let bitmap = STATE.with(|slot| {
            let mut state = slot.borrow_mut();
            let state = state.as_mut()?;
            if state.hwnd != hwnd {
                return None;
            }
            let cover = state.cover.as_ref()?;
            let bounds = if msg == PEEK {
                (MAX_SIZE, MAX_SIZE)
            } else {
                let packed = l.0 as u32;
                (
                    ((packed >> 16) & 0xffff).clamp(1, MAX_SIZE),
                    (packed & 0xffff).clamp(1, MAX_SIZE),
                )
            };
            let cache = if msg == PEEK {
                &mut state.preview
            } else {
                &mut state.thumbnail
            };
            if cache.as_ref().map(|c| c.bounds) != Some(bounds) {
                *cache = Some(CachedBitmap {
                    bounds,
                    bitmap: Rc::new(create_bitmap(cover, bounds).ok()?),
                });
            }
            cache.as_ref().map(|c| c.bitmap.clone())
        });
        if let Some(bitmap) = bitmap {
            if msg == PEEK {
                let _ = DwmSetIconicLivePreviewBitmap(hwnd, bitmap.0, None, 0);
            } else {
                let _ = DwmSetIconicThumbnail(hwnd, bitmap.0, 0);
            }
            return LRESULT(0);
        }
    }
    DefSubclassProc(hwnd, msg, w, l)
}

#[napi]
pub fn taskbar_thumbnail_enable(
    handle: String,
    bytes: Buffer,
    width: u32,
    height: u32,
) -> napi::Result<()> {
    let hwnd = parse_handle(&handle)?;
    validate_cover(&bytes, width, height)?;
    taskbar_thumbnail_disable();
    unsafe {
        if !SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, 0).as_bool() {
            return Err(napi::Error::from_reason(
                "Unable to subclass taskbar preview window",
            ));
        }
        STATE.with(|slot| {
            *slot.borrow_mut() = Some(State {
                hwnd,
                cover: Some(Cover {
                    bytes: bytes.to_vec(),
                    width,
                    height,
                }),
                thumbnail: None,
                preview: None,
            })
        });
        let result = flag(hwnd, DWMWA_HAS_ICONIC_BITMAP, true)
            .and_then(|_| flag(hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, true));
        if let Err(error) = result {
            let _ = flag(hwnd, DWMWA_HAS_ICONIC_BITMAP, false);
            let _ = flag(hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, false);
            let _ = RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID);
            STATE.with(|slot| {
                slot.borrow_mut().take();
            });
            return Err(napi::Error::from_reason(error.to_string()));
        }
    }
    unsafe {
        let _ = DwmInvalidateIconicBitmaps(hwnd);
    }
    Ok(())
}
#[napi]
pub fn taskbar_thumbnail_disable() {
    let state = STATE.with(|slot| slot.borrow_mut().take());
    if let Some(state) = state {
        unsafe {
            if IsWindow(Some(state.hwnd)).as_bool() {
                let _ = flag(state.hwnd, DWMWA_FORCE_ICONIC_REPRESENTATION, false);
                let _ = flag(state.hwnd, DWMWA_HAS_ICONIC_BITMAP, false);
                let _ = RemoveWindowSubclass(state.hwnd, Some(window_proc), SUBCLASS_ID);
                let _ = DwmInvalidateIconicBitmaps(state.hwnd);
            }
        }
    }
}
#[napi]
pub fn taskbar_thumbnail_set_cover(bytes: Buffer, width: u32, height: u32) -> napi::Result<()> {
    validate_cover(&bytes, width, height)?;
    let hwnd = STATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        let state = slot.as_mut()?;
        state.cover = Some(Cover {
            bytes: bytes.to_vec(),
            width,
            height,
        });
        state.thumbnail = None;
        state.preview = None;
        Some(state.hwnd)
    });
    if let Some(hwnd) = hwnd {
        unsafe { DwmInvalidateIconicBitmaps(hwnd) }
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    }
    Ok(())
}
fn validate_cover(bytes: &[u8], width: u32, height: u32) -> napi::Result<()> {
    if width == 0
        || height == 0
        || width > MAX_SIZE
        || height > MAX_SIZE
        || bytes.len() != (width as usize * height as usize * 4)
    {
        return Err(napi::Error::from_reason("Invalid or oversized BGRA cover"));
    }
    Ok(())
}
