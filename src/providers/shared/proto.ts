export interface ProtoField {
	field: number;
	wire: number;
	val?: number;
	raw?: Uint8Array;
}

const textDecoder = new TextDecoder("utf-8");

export function decodeProto(buffer: Uint8Array): ProtoField[] {
	let pos = 0;
	const fields: ProtoField[] = [];
	while (pos < buffer.length) {
		let tagByte = buffer[pos++];
		if (tagByte === undefined) break;
		const wireType = tagByte & 7;
		let fieldNumber = tagByte >> 3;
		let shift = 4;
		while (tagByte & 128) {
			tagByte = buffer[pos++];
			if (tagByte === undefined) break;
			if (shift < 28) {
				fieldNumber |= (tagByte & 127) << shift;
			}
			shift += 7;
		}
		if (wireType === 0) {
			let val = 0n;
			let s = 0n;
			let b = 0;
			do {
				const nextByte = buffer[pos++];
				if (nextByte === undefined) break;
				b = nextByte;
				val |= BigInt(b & 127) << s;
				s += 7n;
			} while (b & 128);
			fields.push({ field: fieldNumber, wire: 0, val: Number(val) });
		} else if (wireType === 1) {
			pos += 8;
			fields.push({ field: fieldNumber, wire: 1 });
		} else if (wireType === 2) {
			let len = 0n;
			let s = 0n;
			let b = 0;
			do {
				const nextByte = buffer[pos++];
				if (nextByte === undefined) break;
				b = nextByte;
				len |= BigInt(b & 127) << s;
				s += 7n;
			} while (b & 128);
			const remaining = buffer.length - pos;
			const safeLen =
				len <= BigInt(remaining) ? Number(len) : Math.max(0, remaining);
			const sub = buffer.subarray(pos, pos + safeLen);
			pos += safeLen;
			fields.push({ field: fieldNumber, wire: 2, raw: sub });
		} else if (wireType === 5) {
			pos += 4;
			fields.push({ field: fieldNumber, wire: 5 });
		} else {
			break;
		}
	}
	return fields;
}

export function protoText(field: ProtoField | undefined): string | null {
	if (!field?.raw) return null;
	try {
		return textDecoder.decode(field.raw);
	} catch {
		return null;
	}
}

export function protoSub(field: ProtoField | undefined): ProtoField[] {
	if (!field?.raw) return [];
	return decodeProto(field.raw);
}
