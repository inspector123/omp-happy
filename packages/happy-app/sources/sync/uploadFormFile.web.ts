/**
 * Web impl: real Blob constructor works, no temp file needed.
 */
export async function appendFormFile(
    formData: FormData,
    bytes: Uint8Array,
    field: string,
    filename: string,
    contentType: string,
): Promise<() => Promise<void>> {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: contentType });
    formData.append(field, blob, filename);
    return async () => { /* no-op */ };
}

export async function uploadBinaryFile(
    url: string,
    bytes: Uint8Array,
    headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; statusText: string }> {
    const response = await fetch(url, {
        method: 'PUT',
        headers,
        body: new Uint8Array(bytes).buffer,
    });
    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
    };
}
