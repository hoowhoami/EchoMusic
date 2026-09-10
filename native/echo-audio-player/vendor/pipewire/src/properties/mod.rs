// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! Properties are used to pass around arbitrary key/value pairs.
//!
//! This module contains wrappers for [`pw_properties`](pw_sys::pw_properties) and related items.

use std::{ffi::CString, fmt, ptr};

mod box_;
pub use box_::*;

/// Transparent wrapper around a [properties](self) object.
///
/// This does not own the underlying object and is usually seen behind a `&` reference.
///
/// For an owning wrapper that can construct properties, see [`PropertiesBox`].
///
/// For an explanation of these, see [Smart pointers to PipeWire
/// objects](crate#smart-pointers-to-pipewire-objects).
#[repr(transparent)]
pub struct Properties(pw_sys::pw_properties);

impl Properties {
    pub fn as_raw(&self) -> &pw_sys::pw_properties {
        &self.0
    }

    /// Obtain a pointer to the underlying `pw_properties` struct.
    ///
    /// The pointer is only valid for the lifetime of the [`Properties`] struct the pointer was obtained from,
    /// and must not be dereferenced after it is dropped.
    ///
    /// Ownership of the `pw_properties` struct is not transferred to the caller and must not be manually freed.
    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_properties {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    pub fn dict(&self) -> &spa::utils::dict::DictRef {
        unsafe { &*(&self.0.dict as *const spa_sys::spa_dict as *const spa::utils::dict::DictRef) }
    }

    // TODO: Impl as trait?
    pub fn to_owned(&self) -> PropertiesBox {
        unsafe {
            let ptr = pw_sys::pw_properties_copy(self.as_raw_ptr());
            PropertiesBox::from_raw(ptr::NonNull::new_unchecked(ptr))
        }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        let key = CString::new(key).expect("key contains null byte");

        let res =
            unsafe { pw_sys::pw_properties_get(self.as_raw_ptr().cast_const(), key.as_ptr()) };

        let res = if !res.is_null() {
            unsafe { Some(std::ffi::CStr::from_ptr(res)) }
        } else {
            None
        };

        // FIXME: Don't return `None` if result is non-utf8
        res.and_then(|res| res.to_str().ok())
    }

    pub fn insert<K, V>(&mut self, key: K, value: V)
    where
        K: Into<Vec<u8>>,
        V: Into<Vec<u8>>,
    {
        let k = CString::new(key).unwrap();
        let v = CString::new(value).unwrap();
        unsafe { pw_sys::pw_properties_set(self.as_raw_ptr(), k.as_ptr(), v.as_ptr()) };
    }

    pub fn remove<T>(&mut self, key: T)
    where
        T: Into<Vec<u8>>,
    {
        let key = CString::new(key).unwrap();
        unsafe { pw_sys::pw_properties_set(self.as_raw_ptr(), key.as_ptr(), std::ptr::null()) };
    }

    pub fn clear(&mut self) {
        unsafe { pw_sys::pw_properties_clear(self.as_raw_ptr()) }
    }
}

impl AsRef<spa::utils::dict::DictRef> for Properties {
    fn as_ref(&self) -> &spa::utils::dict::DictRef {
        self.dict()
    }
}

impl fmt::Debug for Properties {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // FIXME: Debug-print dict key and values directly
        f.debug_tuple("Properties").field(self.as_ref()).finish()
    }
}

impl<K, V> Extend<(K, V)> for Properties
where
    K: Into<Vec<u8>>,
    V: Into<Vec<u8>>,
{
    fn extend<T: IntoIterator<Item = (K, V)>>(&mut self, iter: T) {
        for (k, v) in iter {
            self.insert(k, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new() {
        let props = properties! {
            "K0" => "V0"
        };

        let mut iter = props.dict().iter();
        assert_eq!(("K0", "V0"), iter.next().unwrap());
        assert_eq!(None, iter.next());
    }

    #[test]
    fn remove() {
        let mut props = properties! {
            "K0" => "V0"
        };

        assert_eq!(Some("V0"), props.dict().get("K0"));
        props.remove("K0");
        assert_eq!(None, props.dict().get("K0"));
    }

    #[test]
    fn insert() {
        let mut props = properties! {
            "K0" => "V0"
        };

        assert_eq!(None, props.dict().get("K1"));
        props.insert("K1", "V1");
        assert_eq!(Some("V1"), props.dict().get("K1"));
    }

    #[test]
    fn clone() {
        let props1 = properties! {
            "K0" => "V0"
        };
        let mut props2 = props1.clone();

        props2.insert("K1", "V1");

        // Now, props2 should contain ("K1", "V1"), but props1 should not.

        assert_eq!(None, props1.dict().get("K1"));
        assert_eq!(Some("V1"), props2.dict().get("K1"));
    }

    #[test]
    fn from_dict() {
        use spa::static_dict;

        let mut props = {
            let dict = static_dict! { "K0" => "V0" };

            PropertiesBox::from_dict(&dict)
        };

        assert_eq!(props.dict().len(), 1);
        assert_eq!(props.dict().get("K0"), Some("V0"));

        props.insert("K1", "V1");
        assert_eq!(props.dict().len(), 2);
        assert_eq!(props.dict().get("K1"), Some("V1"));
    }

    #[test]
    fn properties_ref() {
        use std::ops::Deref;

        let props = properties! {
            "K0" => "V0"
        };
        println!("{:?}", &props);
        let props_ref: &Properties = props.deref();

        assert_eq!(props_ref.dict().len(), 1);
        assert_eq!(props_ref.dict().get("K0"), Some("V0"));
        dbg!(&props_ref);

        let props_copy = props_ref.to_owned();
        assert_eq!(props_copy.dict().len(), 1);
        assert_eq!(props_copy.dict().get("K0"), Some("V0"));
    }
}
