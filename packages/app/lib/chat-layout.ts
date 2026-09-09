/**
 * The thread's content column.
 *
 * The message list, the composer and every banner between them are ONE column,
 * and they had drifted: the list was a flat `max-w-3xl` while the composer was
 * `max-w-[40rem] lg:max-w-3xl`, so below `lg` the messages ran 128px wider than
 * the box you typed into. Anything spanning that column imports this.
 */
export const THREAD_COLUMN = "mx-auto w-full max-w-[40rem] lg:max-w-3xl";
