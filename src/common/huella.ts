export const CABECERA_HUELLA = 'X-Device-Fingerprint';

/**
 * De 8 a 128 caracteres de un alfabeto seguro para log y base: letras, dígitos y . _ : + / = -
 * (cubre hexadecimal, base64, base64url y uuid). Sin espacios ni caracteres de control. Es el
 * mismo formato que valida el core.
 */
const FORMATO_HUELLA = /^[A-Za-z0-9._:+/=-]{8,128}$/;

export function esHuellaValida(valor: unknown): valor is string {
  return typeof valor === 'string' && FORMATO_HUELLA.test(valor);
}
