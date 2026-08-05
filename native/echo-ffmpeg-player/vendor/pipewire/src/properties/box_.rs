// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{fmt, mem::ManuallyDrop, ops::Deref, ptr};

use super::Properties;

/// Smart pointer providing unique ownership of a PipeWire [properties](super) object.
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
///
/// # Examples
/// Create a `PropertiesBox` struct and access the stored values by key:
/// ```rust
/// use pipewire::{properties::{properties, PropertiesBox}};
///
/// let props = properties!{
///     "Key" => "Value",
///     "OtherKey" => "OtherValue"
/// };
///
/// assert_eq!(Some("Value"), props.get("Key"));
/// assert_eq!(Some("OtherValue"), props.get("OtherKey"));
/// ```
pub struct PropertiesBox {
    ptr: ptr::NonNull<pw_sys::pw_properties>,
}

impl PropertiesBox {
    /// Create a new, initially empty `Properties` struct.
    pub fn new() -> Self {
        unsafe {
            let raw = std::ptr::NonNull::new(pw_sys::pw_properties_new(std::ptr::null()))
                .expect("Newly created pw_properties should not be null");

            Self::from_raw(raw)
        }
    }

    /// Take ownership of an existing raw `pw_properties` pointer.
    ///
    /// # Safety
    /// - The provided pointer must point to a valid, well-aligned `pw_properties` struct.
    /// - After this call, the returned `PropertiesBox` struct will assume ownership of the data pointed to,
    ///   so that data must not be freed elsewhere.
    pub unsafe fn from_raw(ptr: ptr::NonNull<pw_sys::pw_properties>) -> Self {
        Self { ptr }
    }

    /// Give up ownership of the contained properties , returning a pointer to the raw `pw_properties` struct.
    ///
    /// After this function, the caller is responsible for `pw_properties` struct,
    /// and should make sure it is freed when it is no longer needed.
    pub fn into_raw(self) -> *mut pw_sys::pw_properties {
        let this = ManuallyDrop::new(self);

        this.ptr.as_ptr()
    }

    // TODO: `fn from_string` that calls `pw_sys::pw_properties_new_string`
    // TODO: bindings for pw_properties_update_keys, pw_properties_update, pw_properties_add, pw_properties_add_keys

    /// Create a new `Properties` from a given dictionary.
    ///
    /// All the keys and values from `dict` are copied.
    pub fn from_dict(dict: &spa::utils::dict::DictRef) -> Self {
        let ptr = dict.as_raw();
        unsafe {
            let copy = pw_sys::pw_properties_new_dict(ptr);
            Self::from_raw(ptr::NonNull::new(copy).expect("pw_properties_new_dict() returned NULL"))
        }
    }
}

impl AsRef<Properties> for PropertiesBox {
    fn as_ref(&self) -> &Properties {
        self.deref()
    }
}

impl AsRef<spa::utils::dict::DictRef> for PropertiesBox {
    fn as_ref(&self) -> &spa::utils::dict::DictRef {
        self.deref().as_ref()
    }
}

impl std::ops::Deref for PropertiesBox {
    type Target = Properties;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast().as_ref() }
    }
}

impl std::ops::DerefMut for PropertiesBox {
    fn deref_mut(&mut self) -> &mut Self::Target {
        unsafe { self.ptr.cast().as_mut() }
    }
}

impl Default for PropertiesBox {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for PropertiesBox {
    fn clone(&self) -> Self {
        unsafe {
            let ptr = pw_sys::pw_properties_copy(self.as_raw_ptr());
            let ptr = ptr::NonNull::new_unchecked(ptr);

            Self { ptr }
        }
    }
}

impl<K, V> FromIterator<(K, V)> for PropertiesBox
where
    K: Into<Vec<u8>>,
    V: Into<Vec<u8>>,
{
    fn from_iter<T: IntoIterator<Item = (K, V)>>(iter: T) -> Self {
        let mut props = Self::new();

        props.extend(iter);

        props
    }
}

impl Drop for PropertiesBox {
    fn drop(&mut self) {
        unsafe { pw_sys::pw_properties_free(self.ptr.as_ptr()) }
    }
}

impl fmt::Debug for PropertiesBox {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let dict: &spa::utils::dict::DictRef = self.as_ref();
        // FIXME: Debug-print dict keys and values directly
        f.debug_tuple("PropertiesBox").field(dict).finish()
    }
}

/// A macro for creating a new `Properties` struct with predefined key-value pairs.
///
/// The macro accepts a list of `Key => Value` pairs, separated by commas.
///
/// # Examples:
/// Create a `Properties` struct from literals.
/// ```rust
/// use pipewire::properties::properties;
///
/// let props = properties!{
///    "Key1" => "Value1",
///    "Key2" => "Value2",
/// };
/// ```
///
/// Any expression that evaluates to a `impl Into<Vec<u8>>` can be used for both keys and values.
/// ```rust
/// use pipewire::properties::properties;
///
/// let key = String::from("Key");
/// let value = vec![86, 97, 108, 117, 101]; // "Value" as an ASCII u8 vector.
/// let props = properties!{
///     key => value
/// };
///
/// assert_eq!(Some("Value"), props.get("Key"));
/// ```
#[macro_export]
macro_rules! __properties__ {
    {$($k:expr => $v:expr),+ $(,)?} => {{
        let mut properties = $crate::properties::PropertiesBox::new();
        $(
            properties.insert($k, $v);
        )*
        properties
    }};
}

pub use __properties__ as properties;
