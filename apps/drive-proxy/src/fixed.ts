/** 正文的字节数和声明的不一样。 */
export class LengthMismatch extends Error {
  constructor() {
    super('body length mismatch');
    this.name = 'LengthMismatch';
  }
}

/** 数着字节往下传，多了少了都报 LengthMismatch。上传链接签了大小，靠它保证实际传的就是那么多。 */
export function countedStream(
  body: ReadableStream<Uint8Array>,
  size: number,
  /** 下游（比如往 Drive 的 fetch）会把错误换成自己的，调用方靠这个知道是字节数不对。 */
  onMismatch?: () => void,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > size) {
          onMismatch?.();
          controller.error(new LengthMismatch());
        } else controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== size) {
          onMismatch?.();
          controller.error(new LengthMismatch());
        }
      },
    }),
  );
}
