import assert from 'node:assert/strict';
import test from 'node:test';
import {
  kartaViewPhotoUrl,
  kartaViewTimeMs,
  normalizePhoto,
  resizedImageUrl,
} from './policy.js';

/** A photo record as /2.0/photo returns it (trimmed to what is read). */
function record(overrides = {}) {
  return {
    id: '7102491',
    sequenceId: '14010',
    sequenceIndex: '950',
    lat: '42.335712',
    lng: '-83.048301',
    matchLat: '42.335731506347656',
    matchLng: '-83.04828643798828',
    heading: '299.58',
    fieldOfView: '0',
    projection: 'PLANE',
    shotDate: '2016-08-23 20:17:47.000',
    dateAdded: '2016-08-24 04:01:07',
    storage: 'storage1',
    filepath: '2016/8/24/{{sizeprefix}}/14010_ba53c_57bd1d23d50b7.jpg',
    filepathLTh: '2016/8/24/lth/14010_ba53c_57bd1d23d50b7.jpg',
    filepathProc: '2016/8/24/proc/14010_ba53c_57bd1d23d50b7.jpg',
    fileurl:
      'https://storage1.openstreetcam.org/files/photo/2016/8/24/{{sizeprefix}}/14010_ba53c_57bd1d23d50b7.jpg',
    fileurlLTh:
      'https://storage1.openstreetcam.org/files/photo/2016/8/24/lth/14010_ba53c_57bd1d23d50b7.jpg',
    fileurlProc:
      'https://storage1.openstreetcam.org/files/photo/2016/8/24/proc/14010_ba53c_57bd1d23d50b7.jpg',
    ...overrides,
  };
}

test('a photo record normalizes to numbers, the road-matched position and UTC capture time', () => {
  const photo = normalizePhoto(record());
  assert.equal(photo.id, '7102491');
  assert.equal(photo.sequenceId, '14010');
  assert.equal(photo.sequenceIndex, 950);
  assert.equal(photo.lat, 42.335731506347656);
  assert.equal(photo.lon, -83.04828643798828);
  assert.equal(photo.heading, 299.58);
  assert.equal(photo.isPano, false);
  assert.equal(photo.capturedAt, Date.UTC(2016, 7, 23, 20, 17, 47));
  assert.equal(photo.urls.pano, null);
});

test('photo files come from the storage host the record names, not the one its URLs say', () => {
  // The API writes storage1 into every URL; this photo lives on storage2.
  const photo = normalizePhoto(record({ storage: 'storage2' }));
  assert.equal(
    photo.urls.view,
    'https://storage2.openstreetcam.org/files/photo/2016/8/24/lth/14010_ba53c_57bd1d23d50b7.jpg',
  );
  assert.equal(
    photo.urls.full,
    'https://storage2.openstreetcam.org/files/photo/2016/8/24/proc/14010_ba53c_57bd1d23d50b7.jpg',
  );
  // The link goes through the image proxy, which serves photos whose
  // storage host answers 502 directly.
  const link = kartaViewPhotoUrl(photo);
  assert.match(link, /^https:\/\/cdn\.kartaview\.org\/pr:sharp\/[\w-]+$/);
  assert.equal(
    Buffer.from(link.split('/').at(-1), 'base64url').toString(),
    photo.urls.full,
  );
  // An unexpected storage value falls back to the URLs as given.
  const odd = normalizePhoto(record({ storage: 'https://evil.example' }));
  assert.match(odd.urls.view, /^https:\/\/storage1\.openstreetcam\.org\//);
  // No large thumbnail path: the size prefix fills in.
  const bare = normalizePhoto(
    record({ filepathLTh: '', fileurlLTh: '', storage: 'storage3' }),
  );
  assert.equal(
    bare.urls.view,
    'https://storage3.openstreetcam.org/files/photo/2016/8/24/lth/14010_ba53c_57bd1d23d50b7.jpg',
  );
});

test('a 360° photo keeps its equirectangular image; the unmatched position is the fallback', () => {
  const photo = normalizePhoto(
    record({
      projection: 'SPHERE',
      fieldOfView: '360',
      matchLat: '0',
      matchLng: '0',
      storage: 'storage13',
      filepathProc: '2022/10/6/wrapped_proc/6187609_626b8.jpg',
    }),
  );
  assert.equal(photo.isPano, true);
  assert.equal(photo.lat, 42.335712);
  assert.equal(
    photo.urls.pano,
    'https://storage13.openstreetcam.org/files/photo/2022/10/6/wrapped_proc/6187609_626b8.jpg',
  );
  // A sphere without a wrapped image has nothing to project.
  assert.equal(
    normalizePhoto(record({ projection: 'SPHERE', fieldOfView: '360' })).urls
      .pano,
    null,
  );
});

test('records without an id or a position are dropped; a missing heading is null', () => {
  assert.equal(normalizePhoto(null), null);
  // 0,0 is a missing fix.
  assert.equal(
    normalizePhoto(
      record({ lat: '0', lng: '0', matchLat: '0', matchLng: '0' }),
    ),
    null,
  );
  assert.equal(normalizePhoto(record({ lat: '95', matchLat: '95' })), null);
  assert.equal(normalizePhoto(record({ id: undefined })), null);
  assert.equal(
    normalizePhoto(
      record({ lat: 'x', lng: 'y', matchLat: undefined, matchLng: undefined }),
    ),
    null,
  );
  assert.equal(normalizePhoto(record({ heading: '' })).heading, null);
  assert.equal(normalizePhoto(record({ heading: '0' })).heading, 0);
  assert.equal(normalizePhoto(record({ heading: 'n/a' })).heading, null);
});

test('timestamps parse as UTC; years before 1990 and garbage are unknown', () => {
  assert.equal(kartaViewTimeMs('2022-03-21'), Date.UTC(2022, 2, 21));
  assert.equal(
    kartaViewTimeMs('2022-03-21T06:42:59'),
    Date.UTC(2022, 2, 21, 6, 42, 59),
  );
  assert.equal(kartaViewTimeMs('0000-00-00 00:00:00'), null);
  assert.equal(kartaViewTimeMs(''), null);
  assert.equal(kartaViewTimeMs(null), null);
  const fallback = normalizePhoto(record({ shotDate: null }));
  assert.equal(fallback.capturedAt, Date.UTC(2016, 7, 24, 4, 1, 7));
});

test('resized images go through the proxy with a base64url address', () => {
  const url = resizedImageUrl(
    'https://storage13.openstreetcam.org/files/photo/a?b=c+d',
    [1024, 512],
  );
  const [, encoded] = /\/rs:fit:1024:512\/(.+)$/.exec(url);
  assert.match(url, /^https:\/\/cdn\.kartaview\.org\/pr:sharp\/rs:fit:/);
  assert.doesNotMatch(encoded, /[+/=]/);
  const decoded = Buffer.from(
    encoded.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString();
  assert.equal(
    decoded,
    'https://storage13.openstreetcam.org/files/photo/a?b=c+d',
  );
  assert.equal(resizedImageUrl(null, [1, 1]), null);
});
