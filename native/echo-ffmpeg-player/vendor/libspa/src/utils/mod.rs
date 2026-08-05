//! Miscellaneous and utility items.

pub mod dict;
mod direction;
pub use direction::*;
pub mod hook;
pub mod list;
pub mod result;

use bitflags::bitflags;
use std::{
    ffi::CStr,
    fmt::{self, Debug, Formatter, Write},
    os::raw::c_uint,
};

pub(crate) fn fmt_pascal_case(f: &mut Formatter<'_>, s: &str) -> fmt::Result {
    for part in s.split(|c: char| c == ':' || c.is_whitespace()) {
        if part.is_empty() {
            continue;
        }

        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            f.write_char(first.to_ascii_uppercase())?;
            f.write_str(chars.as_str())?;
        }
    }

    Ok(())
}

pub use spa_sys::spa_fraction as Fraction;
pub use spa_sys::spa_point as Point;
pub use spa_sys::spa_rectangle as Rectangle;
pub use spa_sys::spa_region as Region;

use crate::pod::CanonicalFixedSizedPod;

/// An enumerated value in a pod
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub struct Id(pub u32);

/// A file descriptor in a pod
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
#[repr(transparent)]
pub struct Fd(pub i64);

#[derive(Debug, Eq, PartialEq, Clone)]
/// the flags and choice of a choice pod.
pub struct Choice<T: CanonicalFixedSizedPod>(pub ChoiceFlags, pub ChoiceEnum<T>);

bitflags! {
    /// [`Choice`] flags
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct ChoiceFlags: u32 {
        // no flags defined yet but we need at least one to keep bitflags! happy
        #[doc(hidden)]
        const _FAKE = 1;
    }
}

#[derive(Debug, PartialEq, Eq, Clone)]
/// a choice in a pod.
pub enum ChoiceEnum<T: CanonicalFixedSizedPod> {
    /// no choice.
    None(T),
    /// range.
    Range {
        /// default value.
        default: T,
        /// minimum value.
        min: T,
        /// maximum value.
        max: T,
    },
    /// range with step.
    Step {
        /// default value.
        default: T,
        /// minimum value.
        min: T,
        /// maximum value.
        max: T,
        /// step.
        step: T,
    },
    /// list.
    Enum {
        /// default value.
        default: T,
        /// alternative values.
        alternatives: Vec<T>,
    },
    /// flags.
    Flags {
        /// default value.
        default: T,
        /// possible flags.
        flags: Vec<T>,
    },
}

#[derive(Copy, Clone, PartialEq, Eq)]
pub struct SpaTypes(pub c_uint);

#[allow(non_upper_case_globals)]
impl SpaTypes {
    /* Basic types */
    pub const None: Self = Self(spa_sys::SPA_TYPE_None);
    pub const Bool: Self = Self(spa_sys::SPA_TYPE_Bool);
    pub const Id: Self = Self(spa_sys::SPA_TYPE_Id);
    pub const Int: Self = Self(spa_sys::SPA_TYPE_Int);
    pub const Long: Self = Self(spa_sys::SPA_TYPE_Long);
    pub const Float: Self = Self(spa_sys::SPA_TYPE_Float);
    pub const Double: Self = Self(spa_sys::SPA_TYPE_Double);
    pub const String: Self = Self(spa_sys::SPA_TYPE_String);
    pub const Bytes: Self = Self(spa_sys::SPA_TYPE_Bytes);
    pub const Rectangle: Self = Self(spa_sys::SPA_TYPE_Rectangle);
    pub const Fraction: Self = Self(spa_sys::SPA_TYPE_Fraction);
    pub const Bitmap: Self = Self(spa_sys::SPA_TYPE_Bitmap);
    pub const Array: Self = Self(spa_sys::SPA_TYPE_Array);
    pub const Struct: Self = Self(spa_sys::SPA_TYPE_Struct);
    pub const Object: Self = Self(spa_sys::SPA_TYPE_Object);
    pub const Sequence: Self = Self(spa_sys::SPA_TYPE_Sequence);
    pub const Pointer: Self = Self(spa_sys::SPA_TYPE_Pointer);
    pub const Fd: Self = Self(spa_sys::SPA_TYPE_Fd);
    pub const Choice: Self = Self(spa_sys::SPA_TYPE_Choice);
    pub const Pod: Self = Self(spa_sys::SPA_TYPE_Pod);

    /* Pointers */
    pub const PointerBuffer: Self = Self(spa_sys::SPA_TYPE_POINTER_Buffer);
    pub const PointerMeta: Self = Self(spa_sys::SPA_TYPE_POINTER_Meta);
    pub const PointerDict: Self = Self(spa_sys::SPA_TYPE_POINTER_Dict);

    /* Events */
    pub const EventDevice: Self = Self(spa_sys::SPA_TYPE_EVENT_Device);
    pub const EventNode: Self = Self(spa_sys::SPA_TYPE_EVENT_Node);

    /* Commands */
    pub const CommandDevice: Self = Self(spa_sys::SPA_TYPE_COMMAND_Device);
    pub const CommandNode: Self = Self(spa_sys::SPA_TYPE_COMMAND_Node);

    /* Objects */
    pub const ObjectParamPropInfo: Self = Self(spa_sys::SPA_TYPE_OBJECT_PropInfo);
    pub const ObjectParamProps: Self = Self(spa_sys::SPA_TYPE_OBJECT_Props);
    pub const ObjectParamFormat: Self = Self(spa_sys::SPA_TYPE_OBJECT_Format);
    pub const ObjectParamBuffers: Self = Self(spa_sys::SPA_TYPE_OBJECT_ParamBuffers);
    pub const ObjectParamMeta: Self = Self(spa_sys::SPA_TYPE_OBJECT_ParamMeta);
    pub const ObjectParamIO: Self = Self(spa_sys::SPA_TYPE_OBJECT_ParamIO);
    pub const ObjectParamProfile: Self = Self(spa_sys::SPA_TYPE_OBJECT_ParamProfile);
    pub const ObjectParamPortConfig: Self = Self(spa_sys::SPA_TYPE_OBJECT_ParamPortConfig);
    pub const ObjectParamRoute: Self = Self(spa_sys::SPA_TYPE_OBJECT_ParamRoute);
    pub const ObjectProfiler: Self = Self(spa_sys::SPA_TYPE_OBJECT_Profiler);
    pub const ObjectParamLatency: Self = Self(spa_sys::SPA_TYPE_OBJECT_ParamLatency);
    pub const ObjectParamProcessLatency: Self = Self(spa_sys::SPA_TYPE_OBJECT_ParamProcessLatency);

    /* vendor extensions */
    pub const VendorPipeWire: Self = Self(spa_sys::SPA_TYPE_VENDOR_PipeWire);

    pub const VendorOther: Self = Self(spa_sys::SPA_TYPE_VENDOR_Other);

    /// Obtain a [`SpaTypes`] from a raw `c_uint` variant.
    pub fn from_raw(raw: c_uint) -> Self {
        Self(raw)
    }

    /// Get the raw [`c_uint`] representing this `SpaTypes`.
    pub fn as_raw(&self) -> c_uint {
        self.0
    }
}

impl Debug for SpaTypes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match *self {
            SpaTypes::VendorPipeWire => f.write_str("SpaTypes::VendorPipeWire"),
            SpaTypes::VendorOther => f.write_str("SpaTypes::VendorOther"),
            _ => {
                let c_str = unsafe {
                    let c_buf =
                        spa_sys::spa_debug_type_find_name(spa_sys::spa_types, self.as_raw());
                    if c_buf.is_null() {
                        return f.write_str("Unknown");
                    }
                    CStr::from_ptr(c_buf)
                };
                let replaced = c_str
                    .to_string_lossy()
                    .replace("Spa:Pointer", "Pointer")
                    .replace("Spa:Pod:Object:Event", "Event")
                    .replace("Spa:Pod:Object:Command", "Command")
                    .replace("Spa:Pod:Object", "Object")
                    .replace("Spa:Pod:", "")
                    .replace("Spa:", "")
                    .replace(':', " ");
                f.write_str("SpaTypes::")?;
                fmt_pascal_case(f, &replaced)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fmt_pascal_case() {
        fn format_pascal(s: &str) -> String {
            struct PascalCase<'a>(&'a str);
            impl<'a> std::fmt::Display for PascalCase<'a> {
                fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
                    fmt_pascal_case(f, self.0)
                }
            }
            format!("{}", PascalCase(s))
        }

        assert_eq!(format_pascal("hello"), "Hello");
        assert_eq!(format_pascal("hello:world"), "HelloWorld");
        assert_eq!(format_pascal("hello world"), "HelloWorld");
        assert_eq!(format_pascal("hello:world test"), "HelloWorldTest");
        assert_eq!(format_pascal("Hello:World"), "HelloWorld");
        assert_eq!(format_pascal("hello::world  test"), "HelloWorldTest");
        assert_eq!(format_pascal(":hello world: "), "HelloWorld");
        assert_eq!(format_pascal("a:b c"), "ABC");
        assert_eq!(format_pascal("foo:bar:baz"), "FooBarBaz");
        assert_eq!(format_pascal("fOo:bAr"), "FOoBAr");
        assert_eq!(
            format_pascal("Spa:Pod:Object:Param:Format"),
            "SpaPodObjectParamFormat"
        );
        assert_eq!(format_pascal(""), "");
        assert_eq!(format_pascal(":::   "), "");
    }

    #[test]
    #[cfg_attr(miri, ignore)]
    fn debug_format() {
        assert_eq!("SpaTypes::None", format!("{:?}", SpaTypes::None));
        assert_eq!(
            "SpaTypes::PointerBuffer",
            format!("{:?}", SpaTypes::PointerBuffer)
        );
        assert_eq!(
            "SpaTypes::EventDevice",
            format!("{:?}", SpaTypes::EventDevice)
        );
        assert_eq!(
            "SpaTypes::CommandDevice",
            format!("{:?}", SpaTypes::CommandDevice)
        );
        assert_eq!(
            "SpaTypes::ObjectParamPropInfo",
            format!("{:?}", SpaTypes::ObjectParamPropInfo)
        );
        assert_eq!(
            "SpaTypes::ObjectProfiler",
            format!("{:?}", SpaTypes::ObjectProfiler)
        );
        assert_eq!(
            "SpaTypes::ObjectParamProcessLatency",
            format!("{:?}", SpaTypes::ObjectParamProcessLatency)
        );
        assert_eq!(
            "SpaTypes::VendorPipeWire",
            format!("{:?}", SpaTypes::VendorPipeWire)
        );
        assert_eq!(
            "SpaTypes::VendorOther",
            format!("{:?}", SpaTypes::VendorOther)
        );
    }
}
