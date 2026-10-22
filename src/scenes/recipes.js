/**
 * Scene recipes optimized for short social clips.
 * Each recipe is deterministic so repeated runs produce similar footage.
 */

import { msg, t } from '../i18n/index.js';

// SKYNET: the Bhote Koshi / Nepal event recipes were removed with their
// CC BY-NC 4.0 data (see NOTICE.md). Event recipes can be added here again.
const EVENT_RECIPES = [];

const PUBLIC_SCENE_RECIPES = [
  {
    id: 'flights-radar',
    title: msg('Global Flights Radar'),
    durationSec: 30,
    style: 'retro',
    ui: { hidePanels: true, hudMode: 'minimal', safeFrame: '16:9' },
    layers: {
      flights: true,
      satellites: false,
      earthquakes: false,
      traffic: false,
    },
    post: {
      bloom: 62,
      sharpen: true,
      detectionMode: 'OFF',
    },
    cameraPath: [
      {
        lat: 20.0,
        lon: -30.0,
        alt: 19000000,
        heading: 25,
        pitch: -65,
        roll: 0,
        duration: 6,
        hold: 1,
      },
      {
        lat: 46.0,
        lon: 2.0,
        alt: 8000000,
        heading: 40,
        pitch: -52,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 35.0,
        lon: 139.0,
        alt: 4200000,
        heading: 22,
        pitch: -46,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 37.6,
        lon: -122.4,
        alt: 1700000,
        heading: 8,
        pitch: -40,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 0.0,
        lon: -20.0,
        alt: 12000000,
        heading: -10,
        pitch: -70,
        roll: 0,
        duration: 4,
        hold: 0,
      },
    ],
  },
  {
    id: 'orbital-watch',
    title: msg('Orbital Watch'),
    durationSec: 32,
    style: 'surveillance',
    ui: { hidePanels: true, hudMode: 'full', safeFrame: '16:9' },
    layers: {
      flights: false,
      satellites: true,
      earthquakes: false,
      traffic: false,
    },
    post: {
      bloom: 58,
      sharpen: false,
      detectionMode: 'SPARSE',
      styleParams: {
        surveillance: {
          gain: 0.62,
          bloom: 0.38,
          scanlineStr: 0.9,
          pixelation: 2.1,
        },
      },
    },
    cameraPath: [
      {
        lat: 28.0,
        lon: -82.0,
        alt: 22000000,
        heading: 0,
        pitch: -82,
        roll: 0,
        duration: 7,
        hold: 1,
      },
      {
        lat: 10.0,
        lon: 20.0,
        alt: 12000000,
        heading: 18,
        pitch: -74,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 35.7,
        lon: 139.7,
        alt: 6500000,
        heading: 24,
        pitch: -64,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 48.8,
        lon: 2.3,
        alt: 3000000,
        heading: 32,
        pitch: -58,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 30.0,
        lon: -25.0,
        alt: 15000000,
        heading: -20,
        pitch: -78,
        roll: 0,
        duration: 4,
        hold: 0,
      },
    ],
  },
  {
    id: 'thermal-threats',
    title: msg('Thermal Threat Board'),
    durationSec: 26,
    style: 'thermal',
    ui: { hidePanels: true, hudMode: 'full', safeFrame: '16:9' },
    layers: {
      flights: false,
      satellites: false,
      earthquakes: true,
      traffic: false,
    },
    post: {
      bloom: 72,
      sharpen: true,
      detectionMode: 'OFF',
      styleParams: {
        thermal: {
          sensitivity: 0.84,
          bloom: 0.78,
          mode: 0.0,
          pixelation: 1.9,
        },
      },
    },
    cameraPath: [
      {
        lat: 37.0,
        lon: -121.0,
        alt: 5200000,
        heading: 20,
        pitch: -62,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 35.7,
        lon: 140.0,
        alt: 3100000,
        heading: 5,
        pitch: -55,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: -36.8,
        lon: 174.7,
        alt: 2600000,
        heading: -12,
        pitch: -50,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 38.0,
        lon: -10.0,
        alt: 9000000,
        heading: 12,
        pitch: -70,
        roll: 0,
        duration: 4,
        hold: 0,
      },
    ],
  },
  {
    id: 'city-overload',
    title: msg('City Overload'),
    durationSec: 30,
    style: 'surveillance',
    ui: { hidePanels: true, hudMode: 'minimal', safeFrame: '9:16' },
    layers: {
      flights: true,
      satellites: true,
      earthquakes: false,
      traffic: true,
    },
    post: {
      bloom: 65,
      sharpen: true,
      detectionMode: 'PANOPTIC',
      styleParams: {
        surveillance: {
          gain: 0.68,
          bloom: 0.42,
          scanlineStr: 1.0,
          pixelation: 2.4,
        },
      },
    },
    cameraPath: [
      {
        lat: 40.73,
        lon: -74.0,
        alt: 1500000,
        heading: 25,
        pitch: -44,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 40.73,
        lon: -74.0,
        alt: 550000,
        heading: 58,
        pitch: -36,
        roll: 0,
        duration: 4,
        hold: 1,
      },
      {
        lat: 40.73,
        lon: -74.0,
        alt: 260000,
        heading: 102,
        pitch: -33,
        roll: 0,
        duration: 4,
        hold: 1,
      },
      {
        lat: 34.05,
        lon: -118.24,
        alt: 1200000,
        heading: 45,
        pitch: -42,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 51.5,
        lon: -0.12,
        alt: 1200000,
        heading: 22,
        pitch: -44,
        roll: 0,
        duration: 5,
        hold: 0,
      },
    ],
  },
  {
    id: 'omniscience-pullback',
    title: msg('Omniscience Pullback'),
    durationSec: 36,
    style: 'retro',
    ui: { hidePanels: true, hudMode: 'full', safeFrame: '16:9' },
    layers: {
      flights: true,
      satellites: true,
      earthquakes: true,
      traffic: true,
    },
    post: {
      bloom: 68,
      sharpen: true,
      detectionMode: 'SPARSE',
      styleParams: {
        retro: {
          pixelation: 4.4,
          distortion: 0.42,
          instability: 0.58,
        },
      },
    },
    cameraPath: [
      {
        lat: 35.68,
        lon: 139.76,
        alt: 280000,
        heading: 30,
        pitch: -26,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 35.68,
        lon: 139.76,
        alt: 900000,
        heading: 26,
        pitch: -38,
        roll: 0,
        duration: 4,
        hold: 1,
      },
      {
        lat: 35.68,
        lon: 139.76,
        alt: 3800000,
        heading: 18,
        pitch: -52,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 20.0,
        lon: 110.0,
        alt: 9500000,
        heading: 8,
        pitch: -66,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 5.0,
        lon: 30.0,
        alt: 18000000,
        heading: -8,
        pitch: -78,
        roll: 0,
        duration: 6,
        hold: 0,
      },
    ],
  },
];

/** Build the recipe list without mutating stored user-authored projects. */
export function createSceneRecipes({ localDemoRecipes = EVENT_RECIPES } = {}) {
  return [...localDemoRecipes, ...PUBLIC_SCENE_RECIPES];
}

export const SCENE_RECIPES = createSceneRecipes();

export const SCENE_APPEND_RECIPES = [];

export function getSceneRecipeById(id) {
  return SCENE_RECIPES.find((recipe) => recipe.id === id) || null;
}

export function getSceneAppendRecipeById(id) {
  return SCENE_APPEND_RECIPES.find((recipe) => recipe.id === id) || null;
}

// Built-in shot titles stay English in recipes and saved projects (upgrades
// and bindings match them verbatim). These are their display names; a title
// the user typed shows as typed. Place names inside them stay Latin.
const BUILTIN_SHOT_TITLES = new Set([
  msg('Global Incident Context'),
  msg('Nepal-Focused Globe Rotation'),
  msg('Bhote Koshi Regional Approach'),
  msg('Bhote Koshi Nearby Cities'),
  msg('Bhote Koshi Incident Corridor'),
  msg('Bhote Koshi Flood Path'),
  msg('Bhote Koshi Corridor Overview'),
  msg('Bhote Koshi Upper Valley'),
  msg('Upper Valley Collapse'),
  msg('Debris-Dammed Lake'),
  msg('Nepal-China Border Gate'),
  msg('Timure Evidence Cluster'),
  msg('Syabru Besi Passage'),
  msg('Bidur / Trishuli Consequence'),
  msg('Second landslide'),
  msg('Mailung / Upper Trishuli bridge'),
  msg('Dandagaun viewpoint restaurant'),
  msg('Devighat / Taadi Khola Bridge'),
  msg('Final view'),
]);

/**
 * Display title for a scene: the localized recipe name while the stored title
 * still matches the built-in verbatim, the stored title otherwise.
 * @param {{id?: string, title?: string}} scene
 * @returns {string}
 */
export function displaySceneTitle(scene) {
  const builtin = SCENE_RECIPES.find((recipe) => recipe.id === scene?.id);
  if (builtin?.title && scene.title === builtin.title) return t(builtin.title);
  const title = scene?.title || '';
  // Only the generated "Scene N" localizes; an operator-typed "Scene 007"
  // keeps its digits, so the number stays a string (no Number() round trip).
  const numbered = /^Scene ([1-9]\d*)$/.exec(title);
  return numbered ? t('Scene {n}', { n: numbered[1] }) : title;
}

/**
 * Display title for a shot: built-in titles and the numbered "Shot N"
 * fallback localize; any other title shows as stored.
 *
 * With `shot`, a built-in title localizes only for a recipe shot
 * (`sourcePackId`), so a typed title that matches a built-in one stays as
 * typed. Without `shot`, the title alone decides.
 * @param {string} title
 * @param {{sourcePackId?: string}} [shot]
 * @param {{id?: string}} [scene] The shot's scene, for projects saved before
 *   shots recorded their source pack.
 * @returns {string}
 */
export function displayShotTitle(title, shot = undefined, scene = undefined) {
  const text = typeof title === 'string' ? title : '';
  const fromRecipe = shot
    ? Boolean(shot.sourcePackId) || recipeDeclaresShotTitle(scene?.id, text)
    : true;
  if (fromRecipe && BUILTIN_SHOT_TITLES.has(text)) return t(text);
  const numbered = /^Shot ([1-9]\d*)$/.exec(text);
  return numbered ? t('Shot {n}', { n: numbered[1] }) : text;
}

/** Whether the built-in recipe behind a scene declares a shot with this title. */
function recipeDeclaresShotTitle(sceneId, title) {
  const recipe = sceneId ? getSceneRecipeById(sceneId) : null;
  return Boolean(
    recipe?.cameraPath?.some((keyframe) => keyframe?.title === title),
  );
}
