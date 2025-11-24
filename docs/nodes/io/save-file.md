# save-file

Write incoming data to disk as an image, JSON, text, or binary file. The node can auto-detect the best mode from the payload or a provided filename/extension.

## Inputs
- **payload** (default): Data to write. Supports raw image objects (`{data,width,height,channels,colorSpace}`), encoded image buffers, plain objects/arrays, strings, or buffers.
- **Alternative path**: Use the *Input* field to read from any `msg`/`flow`/`global` property.

## Properties
- **Folder** (*str | env | msg | flow | global*) – Destination directory. Created if missing.
- **Filename** (*str | msg | flow | global*) – Optional name without path separators. If left blank, a timestamped name is generated. If you include an extension here, it is respected.
- **File Type** (*auto | image | json | text | binary*) – Force the save mode or let the node decide. Auto uses the extension, raw image structure, or Sharp metadata for buffers.
- **Image Format** (*jpg | png | webp*) – Encoding for image saves. Quality and PNG optimization are available.
- **JSON Indent** – Spacing for pretty-printed JSON output.
- **Overwrite protection** – Enabled by default; adds a numeric suffix when the file already exists.
- **Result to** – Where to store summary metadata `{ path, filename, type, extension, sizeBytes, format? }` (default `msg.savedFile`).

## Behavior
- Raw image inputs are validated and encoded with Sharp; BGR/BGRA channels are auto-swapped.
- JSON inputs are pretty-printed; valid JSON strings are kept as-is.
- Text mode writes stringified content; binary mode writes buffers directly (or stringified when not a buffer).
- When overwrite protection is enabled, the node keeps adding `_<n>` until a free filename is found.

## Status
- Shows the final filename, duration, and whether an overwrite was avoided.

## Example flows
- Save final inference results as `results.json` in `/data/out`.
- Persist camera frames as WebP by setting *File Type = image* and *Image Format = webp*.
- Archive arbitrary payloads by pointing *Input* to `msg.myBuffer` and enabling overwrite protection.
