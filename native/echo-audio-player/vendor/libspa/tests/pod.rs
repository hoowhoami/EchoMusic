use libspa::{
    pod::deserialize::PodDeserializer,
    pod::{
        deserialize::{
            DeserializeError, DeserializeSuccess, ObjectPodDeserializer, PodDeserialize,
            StructPodDeserializer, Visitor,
        },
        serialize::{PodSerialize, PodSerializer, SerializeSuccess},
        CanonicalFixedSizedPod, ChoiceValue, Object, Property, PropertyFlags, Value, ValueArray,
    },
    utils::{Choice, ChoiceEnum, ChoiceFlags, Fd, Fraction, Id, Rectangle},
};
use std::{
    ffi::{c_void, CString},
    io::Cursor,
    ptr,
};

pub mod c {
    #[allow(non_camel_case_types)]
    type spa_pod = u8;

    #[link(name = "pod")]
    extern "C" {
        pub fn build_none(buffer: *mut u8, len: usize) -> i32;
        pub fn build_bool(buffer: *mut u8, len: usize, boolean: i32) -> i32;
        pub fn build_id(buffer: *mut u8, len: usize, id: u32) -> i32;
        pub fn build_int(buffer: *mut u8, len: usize, int: i32) -> i32;
        pub fn build_long(buffer: *mut u8, len: usize, long: i64) -> i32;
        pub fn build_float(buffer: *mut u8, len: usize, float: f32) -> i32;
        pub fn build_double(buffer: *mut u8, len: usize, float: f64) -> i32;
        pub fn build_string(buffer: *mut u8, len: usize, string: *const u8) -> i32;
        pub fn build_bytes(buffer: *mut u8, len: usize, bytes: *const u8, len: usize) -> i32;
        pub fn build_rectangle(buffer: *mut u8, len: usize, width: u32, height: u32) -> i32;
        pub fn build_fraction(buffer: *mut u8, len: usize, num: u32, denom: u32) -> i32;
        pub fn build_array(
            buffer: *mut u8,
            len: usize,
            child_size: u32,
            child_type: u32,
            n_elems: u32,
            elems: *const u8,
        ) -> i32;
        pub fn build_test_struct(
            buffer: *mut u8,
            len: usize,
            int: i32,
            string: *const u8,
            rect_width: u32,
            rect_height: u32,
        ) -> *const spa_pod;
        pub fn build_fd(buffer: *mut u8, len: usize, fd: i64) -> i32;
        pub fn build_test_object(buffer: *mut u8, len: usize) -> *const spa_pod;
        pub fn build_choice_i32(
            buffer: *mut u8,
            len: usize,
            choice_type: u32,
            flags: u32,
            n_elems: u32,
            elems: *const i32,
        ) -> *const spa_pod;
        pub fn build_choice_i64(
            buffer: *mut u8,
            len: usize,
            choice_type: u32,
            flags: u32,
            n_elems: u32,
            elems: *const i64,
        ) -> *const spa_pod;
        pub fn build_choice_f32(
            buffer: *mut u8,
            len: usize,
            choice_type: u32,
            flags: u32,
            n_elems: u32,
            elems: *const f32,
        ) -> *const spa_pod;
        pub fn build_choice_f64(
            buffer: *mut u8,
            len: usize,
            choice_type: u32,
            flags: u32,
            n_elems: u32,
            elems: *const f64,
        ) -> *const spa_pod;
        pub fn build_choice_id(
            buffer: *mut u8,
            len: usize,
            choice_type: u32,
            flags: u32,
            n_elems: u32,
            elems: *const u32,
        ) -> *const spa_pod;
        pub fn build_choice_rectangle(
            buffer: *mut u8,
            len: usize,
            choice_type: u32,
            flags: u32,
            n_elems: u32,
            elems: *const u32,
        ) -> *const spa_pod;
        pub fn build_choice_fraction(
            buffer: *mut u8,
            len: usize,
            choice_type: u32,
            flags: u32,
            n_elems: u32,
            elems: *const u32,
        ) -> *const spa_pod;
        pub fn build_choice_fd(
            buffer: *mut u8,
            len: usize,
            choice_type: u32,
            flags: u32,
            n_elems: u32,
            elems: *const i64,
        ) -> *const spa_pod;
        pub fn build_audio_info_raw(
            buffer: *mut u8,
            len: usize,
            id: u32,
            audio_raw: *const spa_sys::spa_audio_info_raw,
        ) -> *const spa_pod;
        pub fn parse_audio_info_raw(val: *const spa_pod) -> i32;
        pub fn build_pointer(
            buffer: *mut u8,
            len: usize,
            type_: u32,
            val: *const std::ffi::c_void,
        ) -> i32;
        pub fn print_pod(pod: *const spa_pod);
    }
}

#[test]
#[cfg_attr(miri, ignore)]
fn none() {
    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::None)
        .unwrap()
        .0
        .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 8];
    assert_eq!(unsafe { c::build_none(vec_c.as_mut_ptr(), vec_c.len()) }, 0);

    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], ()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::None))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn bool_true() {
    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &true)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Bool(true))
        .unwrap()
        .0
        .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    assert_eq!(
        unsafe { c::build_bool(vec_c.as_mut_ptr(), vec_c.len(), 1) },
        0
    );
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], true))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Bool(true)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn bool_false() {
    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &false)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> =
        PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Bool(false))
            .unwrap()
            .0
            .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    assert_eq!(
        unsafe { c::build_bool(vec_c.as_mut_ptr(), vec_c.len(), 0) },
        0
    );

    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], false))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Bool(false)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn int() {
    let int: i32 = 765;

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &int)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Int(int))
        .unwrap()
        .0
        .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    assert_eq!(
        unsafe { c::build_int(vec_c.as_mut_ptr(), vec_c.len(), int) },
        0
    );

    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], int))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Int(int)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn long() {
    let long: i64 = 0x1234_5678_9876_5432;

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &long)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Long(long))
        .unwrap()
        .0
        .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    assert_eq!(
        unsafe { c::build_long(vec_c.as_mut_ptr(), vec_c.len(), long) },
        0
    );

    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], long))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Long(long)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn float() {
    let float: f32 = std::f32::consts::PI;

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &float)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> =
        PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Float(float))
            .unwrap()
            .0
            .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    assert_eq!(
        unsafe { c::build_float(vec_c.as_mut_ptr(), vec_c.len(), float) },
        0
    );

    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], float))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Float(float)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn double() {
    let double: f64 = std::f64::consts::PI;

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &double)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> =
        PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Double(double))
            .unwrap()
            .0
            .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    assert_eq!(
        unsafe { c::build_double(vec_c.as_mut_ptr(), vec_c.len(), double) },
        0
    );

    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], double))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Double(double)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn string() {
    let string = "123456789";

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), string)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> =
        PodSerializer::serialize(Cursor::new(Vec::new()), &Value::String(string.to_owned()))
            .unwrap()
            .0
            .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 24];
    let c_string = CString::new(string).unwrap();
    assert_eq!(
        unsafe {
            c::build_string(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                c_string.as_bytes_with_nul().as_ptr(),
            )
        },
        0
    );
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    // Zero-copy deserializing.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], string))
    );

    // Deserializing by copying.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], String::from(string)))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::String(string.to_string())))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn string_no_padding() {
    // The pod resulting from this string should have no padding bytes.
    let string = "1234567";

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), string)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> =
        PodSerializer::serialize(Cursor::new(Vec::new()), &Value::String(string.to_owned()))
            .unwrap()
            .0
            .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    let c_string = CString::new(string).unwrap();
    assert_eq!(
        unsafe {
            c::build_string(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                c_string.as_bytes_with_nul().as_ptr(),
            )
        },
        0
    );
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    // Zero-copy deserializing.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], string))
    );

    // Deserializing by copying.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], String::from(string)))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::String(string.to_string())))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn string_empty() {
    let string = "";

    let mut vec_c: Vec<u8> = vec![0; 16];
    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), string)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> =
        PodSerializer::serialize(Cursor::new(Vec::new()), &Value::String(string.to_owned()))
            .unwrap()
            .0
            .into_inner();

    let c_string = CString::new(string).unwrap();
    assert_eq!(
        unsafe {
            c::build_string(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                c_string.as_bytes_with_nul().as_ptr(),
            )
        },
        0
    );
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    // Zero-copy deserializing.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], string))
    );

    // Deserializing by copying.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], String::from(string)))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::String(string.to_string())))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn bytes() {
    let bytes = b"123456789";

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), bytes as &[u8])
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> =
        PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Bytes(bytes.to_vec()))
            .unwrap()
            .0
            .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 24];
    assert_eq!(
        unsafe { c::build_bytes(vec_c.as_mut_ptr(), vec_c.len(), bytes.as_ptr(), bytes.len()) },
        0
    );
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    // Zero-copy deserializing.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], bytes as &[u8]))
    );

    // Deserializing by copying.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], Vec::from(bytes as &[u8])))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Bytes(Vec::from(bytes as &[u8]))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn bytes_no_padding() {
    // The pod resulting from this byte array should have no padding bytes.
    let bytes = b"12345678";

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), bytes as &[u8])
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> =
        PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Bytes(bytes.to_vec()))
            .unwrap()
            .0
            .into_inner();
    let mut vec_c = vec![0; 16];
    assert_eq!(
        unsafe { c::build_bytes(vec_c.as_mut_ptr(), vec_c.len(), bytes.as_ptr(), bytes.len()) },
        0
    );
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    // Zero-copy deserializing.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], bytes as &[u8]))
    );

    // Deserializing by copying.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], Vec::from(bytes as &[u8])))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Bytes(Vec::from(bytes as &[u8]))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn bytes_empty() {
    let bytes = b"";

    let mut vec_c: Vec<u8> = vec![0; 8];
    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), bytes as &[u8])
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> =
        PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Bytes(bytes.to_vec()))
            .unwrap()
            .0
            .into_inner();

    assert_eq!(
        unsafe { c::build_bytes(vec_c.as_mut_ptr(), vec_c.len(), bytes.as_ptr(), bytes.len()) },
        0
    );
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    // Zero-copy deserializing.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], bytes as &[u8]))
    );

    // Deserializing by copying.
    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], Vec::from(bytes as &[u8])))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Bytes(Vec::from(bytes as &[u8]))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn rectangle() {
    let rect = Rectangle {
        width: 640,
        height: 480,
    };

    let vec_rs = PodSerializer::serialize(Cursor::new(Vec::new()), &rect)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Rectangle(rect))
        .unwrap()
        .0
        .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    unsafe { c::build_rectangle(vec_c.as_mut_ptr(), vec_c.len(), rect.width, rect.height) };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], rect))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Rectangle(rect)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn fraction() {
    let fraction = Fraction { num: 16, denom: 9 };

    let vec_rs = PodSerializer::serialize(Cursor::new(Vec::new()), &fraction)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Fraction(fraction))
        .unwrap()
        .0
        .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    unsafe {
        c::build_fraction(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            fraction.num,
            fraction.denom,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], fraction))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Fraction(fraction)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_i32() {
    // 3 elements, so the resulting array has 4 bytes padding.
    let array: Vec<i32> = vec![10, 15, 19];

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::Int(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 32];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            <i32 as CanonicalFixedSizedPod>::SIZE,
            spa_sys::SPA_TYPE_Int,
            array.len() as u32,
            array.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::ValueArray(ValueArray::Int(array))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_bool() {
    let array = vec![false, true];
    // encode the bools on 4 bytes
    let array_u32: Vec<u32> = array.iter().map(|b| u32::from(*b)).collect();

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::Bool(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 24];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            <bool as CanonicalFixedSizedPod>::SIZE,
            spa_sys::SPA_TYPE_Bool,
            array_u32.len() as u32,
            array_u32.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::ValueArray(ValueArray::Bool(array))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_empty() {
    let array: Vec<()> = Vec::new();

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::None(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            0,
            spa_sys::SPA_TYPE_None,
            array.len() as u32,
            array.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::ValueArray(ValueArray::None(array))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_id() {
    let array = vec![Id(1), Id(2)];

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::Id(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 24];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            <i32 as CanonicalFixedSizedPod>::SIZE,
            spa_sys::SPA_TYPE_Id,
            array.len() as u32,
            array.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::ValueArray(ValueArray::Id(array))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_long() {
    let array: Vec<i64> = vec![1, 2, 3];

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::Long(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 40];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            <i64 as CanonicalFixedSizedPod>::SIZE,
            spa_sys::SPA_TYPE_Long,
            array.len() as u32,
            array.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::ValueArray(ValueArray::Long(array))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_float() {
    let array: Vec<f32> = vec![1.0, 2.2];

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::Float(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 24];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            <f32 as CanonicalFixedSizedPod>::SIZE,
            spa_sys::SPA_TYPE_Float,
            array.len() as u32,
            array.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::ValueArray(ValueArray::Float(array))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_double() {
    let array = vec![1.0, 2.2];

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::Double(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 32];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            <f64 as CanonicalFixedSizedPod>::SIZE,
            spa_sys::SPA_TYPE_Double,
            array.len() as u32,
            array.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::ValueArray(ValueArray::Double(array))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_rectangle() {
    let array = vec![
        Rectangle {
            width: 800,
            height: 600,
        },
        Rectangle {
            width: 1920,
            height: 1080,
        },
    ];

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::Rectangle(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 32];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            <Rectangle as CanonicalFixedSizedPod>::SIZE,
            spa_sys::SPA_TYPE_Rectangle,
            array.len() as u32,
            array.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((
            &[] as &[u8],
            Value::ValueArray(ValueArray::Rectangle(array))
        ))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_fraction() {
    let array = vec![Fraction { num: 1, denom: 2 }, Fraction { num: 2, denom: 3 }];

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::Fraction(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 32];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            <Fraction as CanonicalFixedSizedPod>::SIZE,
            spa_sys::SPA_TYPE_Fraction,
            array.len() as u32,
            array.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::ValueArray(ValueArray::Fraction(array))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn array_fd() {
    let array = vec![Fd(10), Fd(20)];

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), array.as_slice())
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::ValueArray(ValueArray::Fd(array.clone())),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 32];
    unsafe {
        c::build_array(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            <Fd as CanonicalFixedSizedPod>::SIZE,
            spa_sys::SPA_TYPE_Fd,
            array.len() as u32,
            array.as_ptr() as *const u8,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], array.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::ValueArray(ValueArray::Fd(array))))
    );
}

#[derive(PartialEq, Eq, Debug, Clone)]
struct TestStruct<'s> {
    // Fixed sized pod with padding.
    int: i32,
    // Dynamically sized pod.
    string: &'s str,
    // Another nested struct.
    nested: NestedStruct,
}

#[derive(PartialEq, Eq, Debug, Clone)]
struct NestedStruct {
    rect: Rectangle,
}

impl<'s> PodSerialize for TestStruct<'s> {
    fn serialize<O: std::io::Write + std::io::Seek>(
        &self,
        serializer: PodSerializer<O>,
    ) -> Result<SerializeSuccess<O>, cookie_factory::GenError> {
        let mut struct_serializer = serializer.serialize_struct()?;

        struct_serializer.serialize_field(&self.int)?;
        struct_serializer.serialize_field(self.string)?;
        struct_serializer.serialize_field(&self.nested)?;

        struct_serializer.end()
    }
}

impl PodSerialize for NestedStruct {
    fn serialize<O: std::io::Write + std::io::Seek>(
        &self,
        serializer: PodSerializer<O>,
    ) -> Result<SerializeSuccess<O>, cookie_factory::GenError> {
        let mut struct_serializer = serializer.serialize_struct()?;

        struct_serializer.serialize_field(&self.rect)?;

        struct_serializer.end()
    }
}

impl<'de> PodDeserialize<'de> for TestStruct<'de> {
    fn deserialize(
        deserializer: PodDeserializer<'de>,
    ) -> Result<(Self, DeserializeSuccess<'de>), DeserializeError<&'de [u8]>>
    where
        Self: Sized,
    {
        struct TestVisitor;

        impl<'de> Visitor<'de> for TestVisitor {
            type Value = TestStruct<'de>;
            type ArrayElem = std::convert::Infallible;

            fn visit_struct(
                &self,
                struct_deserializer: &mut StructPodDeserializer<'de>,
            ) -> Result<Self::Value, DeserializeError<&'de [u8]>> {
                Ok(TestStruct {
                    int: struct_deserializer
                        .deserialize_field()?
                        .expect("Input has too few fields"),
                    string: struct_deserializer
                        .deserialize_field()?
                        .expect("Input has too few fields"),
                    nested: struct_deserializer
                        .deserialize_field()?
                        .expect("Input has too few fields"),
                })
            }
        }

        deserializer.deserialize_struct(TestVisitor)
    }
}

impl<'de> PodDeserialize<'de> for NestedStruct {
    fn deserialize(
        deserializer: PodDeserializer<'de>,
    ) -> Result<(Self, DeserializeSuccess<'de>), DeserializeError<&'de [u8]>>
    where
        Self: Sized,
    {
        struct NestedVisitor;

        impl<'de> Visitor<'de> for NestedVisitor {
            type Value = NestedStruct;
            type ArrayElem = std::convert::Infallible;

            fn visit_struct(
                &self,
                struct_deserializer: &mut StructPodDeserializer<'de>,
            ) -> Result<Self::Value, DeserializeError<&'de [u8]>> {
                Ok(NestedStruct {
                    rect: struct_deserializer
                        .deserialize_field()?
                        .expect("Input has too few fields"),
                })
            }
        }

        deserializer.deserialize_struct(NestedVisitor)
    }
}

#[test]
#[cfg_attr(miri, ignore)]
fn struct_() {
    const INT: i32 = 313;
    const STR: &str = "foo";
    const RECT: Rectangle = Rectangle {
        width: 31,
        height: 14,
    };

    let struct_ = TestStruct {
        int: INT,
        string: STR,
        nested: NestedStruct { rect: RECT },
    };

    let struct_val = Value::Struct(vec![
        Value::Int(INT),
        Value::String(STR.to_owned()),
        Value::Struct(vec![Value::Rectangle(RECT)]),
    ]);

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &struct_)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &struct_val)
        .unwrap()
        .0
        .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 64];
    let c_string = CString::new(struct_.string).unwrap();
    let ptr = unsafe {
        c::build_test_struct(
            vec_c.as_mut_ptr(),
            vec_c.len(),
            struct_.int,
            c_string.as_bytes_with_nul().as_ptr(),
            struct_.nested.rect.width,
            struct_.nested.rect.height,
        )
    };
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], struct_.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], struct_val))
    );

    assert_eq!(
        unsafe { PodDeserializer::deserialize_ptr(ptr::NonNull::new(ptr as *mut _).unwrap()) },
        Ok(struct_)
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn id() {
    const ID: Id = Id(7);

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &ID)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Id(ID))
        .unwrap()
        .0
        .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    assert_eq!(
        unsafe { c::build_id(vec_c.as_mut_ptr(), vec_c.len(), ID.0) },
        0
    );

    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], ID))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Id(ID)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn fd() {
    const FD: Fd = Fd(7);

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &FD)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Fd(FD))
        .unwrap()
        .0
        .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 16];
    assert_eq!(
        unsafe { c::build_fd(vec_c.as_mut_ptr(), vec_c.len(), FD.0) },
        0
    );

    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], FD))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((&[] as &[u8], Value::Fd(FD)))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn object() {
    let mut vec_c: Vec<u8> = vec![0; 64];
    let ptr = unsafe { c::build_test_object(vec_c.as_mut_ptr(), vec_c.len()) };

    #[derive(Debug, PartialEq)]
    struct MyProps {
        device: String,
        frequency: f32,
    }

    impl<'de> PodDeserialize<'de> for MyProps {
        fn deserialize(
            deserializer: PodDeserializer<'de>,
        ) -> Result<(Self, DeserializeSuccess<'de>), DeserializeError<&'de [u8]>>
        where
            Self: Sized,
        {
            struct PropsVisitor;

            impl<'de> Visitor<'de> for PropsVisitor {
                type Value = MyProps;
                type ArrayElem = std::convert::Infallible;

                fn visit_object(
                    &self,
                    object_deserializer: &mut ObjectPodDeserializer<'de>,
                ) -> Result<Self::Value, DeserializeError<&'de [u8]>> {
                    let (device, _flags) = object_deserializer
                        .deserialize_property_key::<String>(spa_sys::SPA_PROP_device)?;

                    let (frequency, _flags) = object_deserializer
                        .deserialize_property_key::<f32>(spa_sys::SPA_PROP_frequency)?;

                    Ok(MyProps { device, frequency })
                }
            }

            deserializer.deserialize_object(PropsVisitor)
        }
    }

    let (_, props) = PodDeserializer::deserialize_from::<MyProps>(&vec_c).unwrap();
    assert_eq!(props.device, "hw:0");
    // clippy does not like comparing f32, see https://rust-lang.github.io/rust-clippy/master/#float_cmp
    assert!((props.frequency - 440.0_f32).abs() < f32::EPSILON);

    let props2 = unsafe {
        PodDeserializer::deserialize_ptr::<MyProps>(ptr::NonNull::new(ptr as *mut _).unwrap())
            .unwrap()
    };
    assert_eq!(props, props2);

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((
            &[] as &[u8],
            Value::Object(Object {
                type_: spa_sys::SPA_TYPE_OBJECT_Props,
                id: spa_sys::SPA_PARAM_Props,
                properties: vec![
                    Property {
                        key: spa_sys::SPA_PROP_device,
                        flags: PropertyFlags::empty(),
                        value: Value::String("hw:0".into()),
                    },
                    Property {
                        key: spa_sys::SPA_PROP_frequency,
                        flags: PropertyFlags::empty(),
                        value: Value::Float(440.0)
                    }
                ]
            })
        ))
    );

    // serialization
    impl PodSerialize for MyProps {
        fn serialize<O: std::io::Write + std::io::Seek>(
            &self,
            serializer: PodSerializer<O>,
        ) -> Result<SerializeSuccess<O>, cookie_factory::GenError> {
            let mut obj_serializer = serializer
                .serialize_object(spa_sys::SPA_TYPE_OBJECT_Props, spa_sys::SPA_PARAM_Props)?;

            obj_serializer.serialize_property(
                spa_sys::SPA_PROP_device,
                "hw:0",
                PropertyFlags::empty(),
            )?;
            obj_serializer.serialize_property(
                spa_sys::SPA_PROP_frequency,
                &440.0_f32,
                PropertyFlags::empty(),
            )?;

            obj_serializer.end()
        }
    }

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &props)
        .unwrap()
        .0
        .into_inner();

    assert_eq!(vec_rs, vec_c);
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_range_f32() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Range {
            default: 440.0,
            min: 110.0,
            max: 880.0,
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Float(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 40];
    unsafe {
        assert_ne!(
            c::build_choice_f32(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Range,
                0,
                3,
                &[440.0_f32, 110.0, 880.0] as *const f32,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Float(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_range_i32() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Range {
            default: 5,
            min: 2,
            max: 10,
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Int(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 40];
    unsafe {
        assert_ne!(
            c::build_choice_i32(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Range,
                0,
                3,
                &[5, 2, 10] as *const i32,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Int(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_none_i32() {
    let choice = Choice(ChoiceFlags::empty(), ChoiceEnum::None(5));

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Int(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 32];
    unsafe {
        assert_ne!(
            c::build_choice_i32(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_None,
                0,
                1,
                &[5] as *const i32,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Int(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_step_i32() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Step {
            default: 5,
            min: 2,
            max: 10,
            step: 1,
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Int(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 40];
    unsafe {
        assert_ne!(
            c::build_choice_i32(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Step,
                0,
                4,
                &[5, 2, 10, 1] as *const i32,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Int(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_enum_i32() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Enum {
            default: 5,
            alternatives: vec![2, 10, 1],
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Int(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 40];
    unsafe {
        assert_ne!(
            c::build_choice_i32(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Enum,
                0,
                4,
                &[5, 2, 10, 1] as *const i32,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Int(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_flags_i32() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Flags {
            default: 5,
            flags: vec![2, 10, 1],
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Int(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 40];
    unsafe {
        assert_ne!(
            c::build_choice_i32(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Flags,
                0,
                4,
                &[5, 2, 10, 1] as *const i32,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Int(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_range_i64() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Range {
            default: 440_i64,
            min: 110,
            max: 880,
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Long(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 48];
    unsafe {
        assert_ne!(
            c::build_choice_i64(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Range,
                0,
                3,
                &[440_i64, 110, 880] as *const i64,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Long(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_range_f64() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Range {
            default: 440.0_f64,
            min: 110.0,
            max: 880.0,
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Double(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 48];
    unsafe {
        assert_ne!(
            c::build_choice_f64(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Range,
                0,
                3,
                &[440.0_f64, 110.0, 880.0] as *const f64,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Double(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_enum_id() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Enum {
            default: Id(5),
            alternatives: vec![Id(2), Id(10), Id(1)],
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Id(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 40];
    unsafe {
        assert_ne!(
            c::build_choice_id(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Enum,
                0,
                4,
                &[5_u32, 2, 10, 1] as *const u32,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Id(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_enum_rectangle() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Enum {
            default: Rectangle {
                width: 800,
                height: 600,
            },
            alternatives: vec![
                Rectangle {
                    width: 1920,
                    height: 1080,
                },
                Rectangle {
                    width: 300,
                    height: 200,
                },
            ],
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Rectangle(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 48];
    unsafe {
        assert_ne!(
            c::build_choice_rectangle(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Enum,
                0,
                6,
                &[800_u32, 600, 1920, 1080, 300, 200] as *const u32,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Rectangle(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_enum_fraction() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Enum {
            default: Fraction { num: 1, denom: 2 },
            alternatives: vec![Fraction { num: 2, denom: 3 }, Fraction { num: 1, denom: 3 }],
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Fraction(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 48];
    unsafe {
        assert_ne!(
            c::build_choice_fraction(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Enum,
                0,
                6,
                &[1_u32, 2, 2, 3, 1, 3] as *const u32,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Fraction(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_enum_fd() {
    let choice = Choice(
        ChoiceFlags::empty(),
        ChoiceEnum::Enum {
            default: Fd(5),
            alternatives: vec![Fd(2), Fd(10), Fd(1)],
        },
    );

    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &choice)
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Choice(ChoiceValue::Fd(choice.clone())),
    )
    .unwrap()
    .0
    .into_inner();

    let mut vec_c: Vec<u8> = vec![0; 56];
    unsafe {
        assert_ne!(
            c::build_choice_fd(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_Enum,
                0,
                4,
                &[5_i64, 2, 10, 1] as *const i64,
            ),
            std::ptr::null()
        );
    }
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs, vec_rs_val);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice.clone()))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_c),
        Ok((&[] as &[u8], Value::Choice(ChoiceValue::Fd(choice))))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn choice_extra_values() {
    // deserialize a none choice having more than one values, which are ignored.
    let choice = Choice(ChoiceFlags::empty(), ChoiceEnum::None(5));

    let mut vec_c: Vec<u8> = vec![0; 32];
    unsafe {
        assert_ne!(
            c::build_choice_i32(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                spa_sys::SPA_CHOICE_None,
                0,
                1,
                &[5, 6, 7, 8] as *const i32,
            ),
            std::ptr::null()
        );
    }

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_c),
        Ok((&[] as &[u8], choice))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn pointer() {
    let val = 7;
    let ptr = &val as *const i32;
    const POINTER_TYPE: u32 = 10;
    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &(POINTER_TYPE, ptr))
        .unwrap()
        .0
        .into_inner();
    let vec_rs_val: Vec<u8> = PodSerializer::serialize(
        Cursor::new(Vec::new()),
        &Value::Pointer(POINTER_TYPE, ptr as *const c_void),
    )
    .unwrap()
    .0
    .into_inner();
    let mut vec_c: Vec<u8> = vec![0; 24];
    assert_eq!(
        unsafe {
            c::build_pointer(
                vec_c.as_mut_ptr(),
                vec_c.len(),
                10,
                ptr as *const std::ffi::c_void,
            )
        },
        0
    );
    assert_eq!(vec_rs, vec_c);
    assert_eq!(vec_rs_val, vec_c);

    assert_eq!(
        PodDeserializer::deserialize_from(&vec_rs),
        Ok((&[] as &[u8], (POINTER_TYPE, ptr)))
    );

    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs),
        Ok((
            &[] as &[u8],
            Value::Pointer(POINTER_TYPE, ptr as *const c_void)
        ))
    );
}

use libspa::param::audio::{self, AudioFormat, AudioInfoRaw};

#[test]
#[cfg_attr(miri, ignore)]
fn composite_values() {
    let all_type_values = [
        Value::None,
        Value::Bool(false),
        Value::Id(Id(0)),
        Value::Int(0),
        Value::Long(0),
        Value::Float(0.0),
        Value::Double(0.0),
        Value::String(String::new()),
        Value::Bytes(vec![]),
        Value::Rectangle(Rectangle {
            width: 1,
            height: 1,
        }),
        Value::Fraction(Fraction { num: 0, denom: 1 }),
        Value::Fd(Fd(-1)),
        Value::ValueArray(ValueArray::None(vec![])),
        Value::Struct(vec![]),
        Value::Object(Object {
            type_: 0,
            id: 0,
            properties: vec![],
        }),
        Value::Choice(ChoiceValue::Int(Choice(
            ChoiceFlags::empty(),
            ChoiceEnum::None(0),
        ))),
        Value::Pointer(0, ptr::null_mut()),
    ];

    for value in &all_type_values {
        let (cursor, len) = PodSerializer::serialize(Cursor::new(Vec::new()), value).unwrap();
        let vec_rs_val = cursor.into_inner();
        assert_eq!(len, vec_rs_val.len() as u64);
    }

    let struct_val = Value::Struct(all_type_values.to_vec());
    let (cursor, len) = PodSerializer::serialize(Cursor::new(Vec::new()), &struct_val).unwrap();
    let vec_rs_val = cursor.into_inner();
    assert_eq!(len, vec_rs_val.len() as u64);
    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs_val),
        Ok((&[] as &[u8], struct_val))
    );

    let object_val = Value::Object(Object {
        type_: 0,
        id: 0,
        properties: all_type_values
            .iter()
            .map(|value| Property {
                flags: PropertyFlags::empty(),
                key: 0,
                value: value.clone(),
            })
            .collect(),
    });
    let (cursor, len) = PodSerializer::serialize(Cursor::new(Vec::new()), &object_val).unwrap();
    let vec_rs_val = cursor.into_inner();
    assert_eq!(len, vec_rs_val.len() as u64);
    assert_eq!(
        PodDeserializer::deserialize_any_from(&vec_rs_val),
        Ok((&[] as &[u8], object_val))
    );
}

#[test]
#[cfg_attr(miri, ignore)]
fn audio_info_raw() {
    let id = 1;
    let position = [0; audio::MAX_CHANNELS];
    let mut info = AudioInfoRaw::new();
    info.set_channels(1);
    info.set_rate(44100);
    info.set_format(AudioFormat::S8);
    info.set_position(position);

    let obj_rs = Value::Object(Object {
        type_: spa_sys::SPA_TYPE_OBJECT_Format,
        id,
        properties: info.into(),
    });
    let vec_rs: Vec<u8> = PodSerializer::serialize(Cursor::new(Vec::new()), &obj_rs)
        .unwrap()
        .0
        .into_inner();

    let mut vec_c: Vec<u8> = vec![0; vec_rs.len()];
    let obj_c: spa_sys::spa_audio_info_raw = info.as_raw();
    assert_ne!(
        unsafe { c::build_audio_info_raw(vec_c.as_mut_ptr(), vec_c.len(), id, &obj_c) },
        std::ptr::null()
    );
    assert_eq!(vec_rs, vec_c);
    assert!(unsafe { c::parse_audio_info_raw(vec_c.as_mut_ptr()) } > 0);
}
