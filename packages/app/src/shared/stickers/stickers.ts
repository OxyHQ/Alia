/**
 * Stickers from Oxy's shared catalogue (`@oxy.so/stickers`), drawn by Bloom's `Sticker` above an
 * empty state. Mention uses the same catalogue and the same ids.
 *
 * Each value is a catalogue id: the art can be redrawn in Oxy without an Alia release, and a
 * published sticker never stops resolving. The emoji and pack in each comment say what the sticker
 * is, for whoever reads this without the catalogue open. Changing one screen's sticker is one line.
 *
 * Nothing here is bundled: the art lives in the catalogue, so it stays out of the app binary and
 * out of this repository.
 */

/** 😢 bear-friends-forever: the sad bear on a swing. */
const SAD_BEAR = '01a0eada-7bc3-73de-a931-fcd4c202a4db';
/** 👀 blob-blah-blah (watching) */
const BLOB_WATCHING = '01a0eada-9cc9-7d48-98e1-d6ef59830aa7';
/** 🤷 blob-blah-blah (shrugging) */
const BLOB_SHRUGGING = '01a0eada-9343-7430-8062-8424ea19b842';
/** 😅 blob-blah-blah (oops) */
const BLOB_OOPS = '01a0eada-959f-721f-92e0-3ddfa8ae8e27';
/** 👋 match-ready (wave) */
const MATCH_WAVE = '01a0eadb-761a-7b2b-bcb2-beee24b2cd17';
/** 👍 springtime (thumbsup) */
const SPRING_THUMBSUP = '01a0eadb-c6a9-7c35-8433-c308f9a4ce03';
/** 👋 introvert-life (wave) */
const INTROVERT_WAVE = '01a0eadb-5dd8-70d1-b12b-5083a0c5b01a';
/** 🍵 escape-from-reality (siptea) */
const ESCAPE_SIPTEA = '01a0eadb-0917-74c4-be61-8fd534b4faea';
/** 🥳 fearless-bird (partytime) */
const BIRD_PARTYTIME = '01a0eadb-3895-7264-97c4-f7aaf2d722ef';
/** 💻 escape-from-reality (laptop) */
const ESCAPE_LAPTOP = '01a0eadb-07c7-7315-94aa-6d8639943c21';
/** 😌 introvert-life (chilling) */
const INTROVERT_CHILLING = '01a0eadb-6e8f-727e-b102-914aa907f2a5';

/** Screen (or state) → the sticker above its empty state. */
export const EMPTY_STATE_STICKERS = {
  /** The agents list, with none yet. */
  agentsEmpty: INTROVERT_WAVE,
  /** The agents list, a search that matched none. */
  agentsNoResults: BLOB_SHRUGGING,
  /** An agent's session log, with nothing recorded. */
  agentSession: BLOB_WATCHING,
  /** Tasks, the active tab. */
  tasksActive: INTROVERT_CHILLING,
  /** Tasks, the finished tab. */
  tasksHistory: ESCAPE_SIPTEA,
  /** Notifications, none yet. */
  notifications: SPRING_THUMBSUP,
  /** Shows, none yet. */
  shows: BIRD_PARTYTIME,
  /** One show, no episodes yet. */
  showEpisodes: ESCAPE_LAPTOP,
  /** The skills catalogue, a search that matched none. */
  skillsNoResults: BLOB_SHRUGGING,
  /** The skills catalogue, nothing in it yet. */
  skillsEmpty: BLOB_WATCHING,
  /** The referrals list, none yet. */
  referrals: INTROVERT_WAVE,
  /** 😕 taste-buds (confused): the 404 page. */
  notFound: '01a0eadb-ee07-7b6f-a868-3fea8fc02476',
  /** An agent that does not exist or is not the person's to see. */
  agentNotFound: BLOB_OOPS,
  /** A skill that does not exist or is not the person's to see. */
  skillNotFound: BLOB_OOPS,
  /** An invitation that is no longer valid. */
  inviteUnavailable: BLOB_OOPS,
  /** A list that could not be loaded. */
  loadError: SAD_BEAR,
} as const;

export type EmptyStateStickerName = keyof typeof EMPTY_STATE_STICKERS;
