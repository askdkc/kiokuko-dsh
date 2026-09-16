import { fail } from './contracts.js'

/** Linux classic BPF, consumed by Bubblewrap before exec. No native compiler needed. */
export function networkFilter(arch: string): Buffer {
  const audit = arch === 'x64' ? 0xc000003e : arch === 'arm64' ? 0xc00000b7 : fail('UNSUPPORTED_CPU', 'Linux の Lisp は x64 / arm64 が対象です。')
  const sockets = arch === 'x64' ? [41, 53] : [198, 199]
  // Deny socket creation and io_uring (which can create sockets without socket()).
  const denied = [...sockets, 425, 426, 427]
  const instructions = [
    [0x20, 0, 0, 4], [0x15, 1, 0, audit], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x00050001],
    ...denied.flatMap(nr => [[0x15, 0, 1, nr], [0x06, 0, 0, 0x00050001]]),
    [0x06, 0, 0, 0x7fff0000],
  ]
  const buffer = Buffer.alloc(instructions.length * 8)
  instructions.forEach(([code, yes, no, value], index) => {
    buffer.writeUInt16LE(code!, index * 8); buffer[index * 8 + 2] = yes!; buffer[index * 8 + 3] = no!; buffer.writeUInt32LE(value!, index * 8 + 4)
  })
  return buffer
}
