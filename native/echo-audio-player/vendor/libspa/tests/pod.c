#include <assert.h>
#include <stdarg.h>

#include <spa/pod/builder.h>
#include <spa/debug/pod.h>
#include <spa/param/audio/format-utils.h>

int build_none(uint8_t *buffer, size_t len)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_none(&b);
}

int build_bool(uint8_t *buffer, size_t len, bool boolean)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_bool(&b, boolean);
}

int build_id(uint8_t *buffer, size_t len, uint32_t id)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_id(&b, id);
}

int build_int(uint8_t *buffer, size_t len, int32_t integer)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_int(&b, integer);
}

int build_long(uint8_t *buffer, size_t len, int64_t integer)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_long(&b, integer);
}

int build_float(uint8_t *buffer, size_t len, float f)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_float(&b, f);
}

int build_double(uint8_t *buffer, size_t len, double d)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_double(&b, d);
}

int build_string(uint8_t *buffer, size_t len, const char *string)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_string(&b, string);
}

int build_bytes(uint8_t *buffer, size_t len, const void *bytes, size_t bytes_len)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_bytes(&b, bytes, bytes_len);
}

int build_rectangle(uint8_t *buffer, size_t len, uint32_t width, uint32_t height)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_rectangle(&b, width, height);
}

int build_fraction(uint8_t *buffer, size_t len, uint32_t num, uint32_t denom)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_fraction(&b, num, denom);
}

int build_array(uint8_t *buffer, size_t len, uint32_t child_size, uint32_t child_type, uint32_t n_elems, const void *elems)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_array(&b, child_size, child_type, n_elems, elems);
}

int build_fd(uint8_t *buffer, size_t len, int64_t fd)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_fd(&b, fd);
}

struct spa_pod *build_test_struct(
	uint8_t *buffer, size_t len, int32_t num, const char *string, uint32_t rect_width, uint32_t rect_height)
{
	struct spa_pod_frame outer, inner;
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);

	spa_pod_builder_push_struct(&b, &outer);
	spa_pod_builder_int(&b, num);
	spa_pod_builder_string(&b, string);

	spa_pod_builder_push_struct(&b, &inner);
	spa_pod_builder_rectangle(&b, rect_width, rect_height);

	spa_pod_builder_pop(&b, &inner);
	return spa_pod_builder_pop(&b, &outer);
}

struct spa_pod *build_test_object(uint8_t *buffer, size_t len)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);

	return spa_pod_builder_add_object(&b,
									  SPA_TYPE_OBJECT_Props, SPA_PARAM_Props,
									  SPA_PROP_device, SPA_POD_String("hw:0"),
									  SPA_PROP_frequency, SPA_POD_Float(440.0f));
}

struct spa_pod *build_choice_i32(uint8_t *buffer, size_t len, uint32_t choice_type, uint32_t flags, uint32_t n_elems, uint32_t *elems)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	struct spa_pod_frame f;
	uint32_t i;

	spa_pod_builder_push_choice(&b, &f, choice_type, flags);

	for (i = 0; i < n_elems; i++)
	{
		spa_pod_builder_int(&b, elems[i]);
	}

	return spa_pod_builder_pop(&b, &f);
}

struct spa_pod *build_choice_i64(uint8_t *buffer, size_t len, uint32_t choice_type, uint32_t flags, uint32_t n_elems, uint64_t *elems)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	struct spa_pod_frame f;
	uint32_t i;

	spa_pod_builder_push_choice(&b, &f, choice_type, flags);

	for (i = 0; i < n_elems; i++)
	{
		spa_pod_builder_long(&b, elems[i]);
	}

	return spa_pod_builder_pop(&b, &f);
}

struct spa_pod *build_choice_f32(uint8_t *buffer, size_t len, uint32_t choice_type, uint32_t flags, uint32_t n_elems, float *elems)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	struct spa_pod_frame f;
	uint32_t i;

	spa_pod_builder_push_choice(&b, &f, choice_type, flags);

	for (i = 0; i < n_elems; i++)
	{
		spa_pod_builder_float(&b, elems[i]);
	}

	return spa_pod_builder_pop(&b, &f);
}

struct spa_pod *build_choice_f64(uint8_t *buffer, size_t len, uint32_t choice_type, uint32_t flags, uint32_t n_elems, double *elems)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	struct spa_pod_frame f;
	uint32_t i;

	spa_pod_builder_push_choice(&b, &f, choice_type, flags);

	for (i = 0; i < n_elems; i++)
	{
		spa_pod_builder_double(&b, elems[i]);
	}

	return spa_pod_builder_pop(&b, &f);
}

struct spa_pod *build_choice_id(uint8_t *buffer, size_t len, uint32_t choice_type, uint32_t flags, uint32_t n_elems, uint32_t *elems)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	struct spa_pod_frame f;
	uint32_t i;

	spa_pod_builder_push_choice(&b, &f, choice_type, flags);

	for (i = 0; i < n_elems; i++)
	{
		spa_pod_builder_id(&b, elems[i]);
	}

	return spa_pod_builder_pop(&b, &f);
}

struct spa_pod *build_choice_rectangle(uint8_t *buffer, size_t len, uint32_t choice_type, uint32_t flags, uint32_t n_elems, uint32_t *elems)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	struct spa_pod_frame f;
	uint32_t i;

	assert(n_elems % 2 == 0); // elements are actually (width, height) pairs

	spa_pod_builder_push_choice(&b, &f, choice_type, flags);

	for (i = 0; i < n_elems; i += 2)
	{
		spa_pod_builder_rectangle(&b, elems[i], elems[i + 1]);
	}

	return spa_pod_builder_pop(&b, &f);
}

struct spa_pod *build_choice_fraction(uint8_t *buffer, size_t len, uint32_t choice_type, uint32_t flags, uint32_t n_elems, uint32_t *elems)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	struct spa_pod_frame f;
	uint32_t i;

	assert(n_elems % 2 == 0); // elements are actually (num, denom) pairs

	spa_pod_builder_push_choice(&b, &f, choice_type, flags);

	for (i = 0; i < n_elems; i += 2)
	{
		spa_pod_builder_fraction(&b, elems[i], elems[i + 1]);
	}

	return spa_pod_builder_pop(&b, &f);
}

struct spa_pod *build_choice_fd(uint8_t *buffer, size_t len, uint32_t choice_type, uint32_t flags, uint32_t n_elems, int64_t *elems)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	struct spa_pod_frame f;
	uint32_t i;

	spa_pod_builder_push_choice(&b, &f, choice_type, flags);

	for (i = 0; i < n_elems; i++)
	{
		spa_pod_builder_fd(&b, elems[i]);
	}

	return spa_pod_builder_pop(&b, &f);
}

struct spa_pod *build_audio_info_raw(uint8_t *buffer, size_t len, uint32_t id, struct spa_audio_info_raw *info) {
  struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
  return spa_format_audio_raw_build(&b, id, info);
}

int parse_audio_info_raw(const struct spa_pod *format) {
  struct spa_audio_info_raw info;
  int res = spa_format_audio_raw_parse(format, &info);
  return res;
}

int build_pointer(uint8_t *buffer, size_t len, uint32_t type, const void *val)
{
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, len);
	return spa_pod_builder_pointer(&b, type, val);
}

void print_pod(const struct spa_pod *pod)
{
	spa_debug_pod(0, NULL, pod);
}
