extern crate napi_build;

fn main() {
    napi_build::setup();

    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
    }
}
