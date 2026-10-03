/*
 * fdk-aac-sys 0.5.0 在 MSVC ARM64 上的兼容垫片
 *
 * 通过 CFLAGS_aarch64_pc_windows_msvc 的 -FI 强制包含（MSVC 的 /D 不支持函数式
 * 宏，只能用强制包含的方式注入），仅 Windows ARM64 CI 构建需要。
 *
 * 背景：MSVC ARM64 只定义 _M_ARM64，fdk-aac 的 FDK_archdef.h 没识别它，会落入
 * #warning 兜底，VS18 起 MSVC 把 #warning 当 fatal error C1188。工作流因此补了
 * -D__aarch64__ 让它走 header 自带的 ARM64 分支；但该分支同时定义 __arm__，
 * 会打开两处 GCC 专属语法：
 *   - libSBRdec/src/hbe.cpp：3 处 __attribute__((always_inline))（__arm__ 分支）
 *   - libSACdec/src/sac_reshapeBBEnv.cpp：1 处 __attribute__((noinline))（__aarch64__ 分支）
 * MSVC 不认识 __attribute__，报 error C2065。这里把它定义成空宏即可：这 4 处都
 * 只是内联提示，置空不影响语义（上游其它 arm 头文件同样用 __GNUC__ 守卫绕开）。
 *
 * 生效范围：fdk-aac-sys 的 build.rs 会给它的每个编译单元注入 FDK_FALLTHROUGH，
 * 同一台机器上其它 crate 的编译单元（zstd、sqlite、opencc 等）命中不了这个守卫，
 * 不会被垫片影响。
 */
#if defined(FDK_FALLTHROUGH) && defined(_MSC_VER) && !defined(__clang__)
/* 强制包含的文件名本身会出现在 __FILE__ 相关诊断里，这里只需静默生效 */
#define __attribute__(x)
#endif
