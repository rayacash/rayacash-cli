// Las esperas entre reintentos cuando no hay conexión con la API: 1, 2, 4, 8, 16 y 30 s, con un
// ±20 % al azar para que muchas escuchas no reintenten a la vez. Un 200 la reinicia.

const STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const LAST_MS = 30_000;

export class Backoff {
  #attempt = 0;
  #random: () => number;

  constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  /** La próxima espera, en ms. */
  next(): number {
    const base = STEPS_MS[this.#attempt] ?? LAST_MS;
    this.#attempt += 1;
    return Math.round(base * (0.8 + 0.4 * this.#random()));
  }

  reset(): void {
    this.#attempt = 0;
  }
}
