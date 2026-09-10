mergeInto(LibraryManager.library, {
	js_read_file: (file_id, offset, buffer_ptr, length) => {
		return Module.js_read_file(file_id, offset, length, buffer_ptr);
	},
	js_get_file_size: (file_id) => Module.js_get_file_size(file_id),
});
