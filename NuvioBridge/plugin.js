(function () {
  // ===========================================================================
  // NUVIO BRIDGE — SkyStream Plugin v4.0
  // Ultra-reliable universal bridge for 150+ Nuvio streaming providers.
  // Uses native http_get/http_post for maximum SkyStream compatibility.
  // ===========================================================================

  // ===========================================================================
  // CONFIGURATION
  // ===========================================================================

  var TAG = 'NuvioBridge';

  // --- Nuvio manifest sources ---
  var NUVIO_SOURCES = [
    { id: 'yoruix',        name: "Yoru's Nuvio",       url: 'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json' },
    { id: 'd3adlyrocket',  name: 'D3adlyRocket',        url: 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json' },
    { id: 'phisher98',     name: 'Phisher98',           url: 'https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/refs/heads/main/manifest.json' },
    { id: 'michat88',      name: 'Michat88',            url: 'https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main/manifest.json' },
    { id: 'piratezoro9',   name: "Kabir's Providers",   url: 'https://raw.githubusercontent.com/PirateZoro9/nuvio-kabir-providers/refs/heads/main/manifest.json' },
    { id: 'hihihihiray',   name: "Ray's Plugins",       url: 'https://raw.githubusercontent.com/hihihihihiiray/plugins/refs/heads/main/manifest.json' },
    { id: 'abinanthankv',  name: 'NuvioRepo',           url: 'https://raw.githubusercontent.com/Abinanthankv/NuvioRepo/refs/heads/master/manifest.json' }
  ];

  // --- User-Agent strings ---
  var UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  var UA_MOBILE  = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.134 Mobile Safari/537.36';

  // --- Headers for different contexts ---
  var H_EXTERNAL = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive'
  };
  var H_JSON = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'application/json'
  };
  var H_MOBILE = {
    'User-Agent': UA_MOBILE,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  // --- TMDB ---
  var TMDB_KEY = '68e094699525b18a70bab2f86b1fa706';
  var TMDB_BASE = 'https://api.themoviedb.org/3';
  var IMG_BASE = 'https://image.tmdb.org/t/p';

  // --- Performance tunables ---
  var FETCH_CODE_TIMEOUT   = 8000;   // ms to download a provider's JS
  var PROVIDER_TIMEOUT     = 10000;  // ms for a provider's getStreams call
  var BATCH_SIZE           = 10;     // providers per parallel batch
  var EARLY_EXIT_STREAMS   = 30;     // stop once we have this many unique streams
  var MAX_HOME_ITEMS       = 20;     // items per home category
  var HOME_PARALLEL_FETCHES = 5;     // home categories fetched concurrently

  // ===========================================================================
  // STATE
  // ===========================================================================

  var _discoveryCache  = null;      // [{id, name, sourceName, fileUrl, supportedTypes}]
  var _discoveryPromise = null;     // in-flight discovery promise
  var _fnCache         = {};        // id -> getStreams function
  var _streamCache     = {};        // cacheKey -> [StreamResult]
  var _providerScore   = {};        // id -> score (higher = more reliable)

  // ===========================================================================
  // LOGGING
  // ===========================================================================

  function log(msg) {
    try { console.log('[' + TAG + '] ' + msg); } catch (e) {}
  }

  // ===========================================================================
  // NATIVE HTTP LAYER  (wraps http_get / http_post into Promises)
  // ===========================================================================

  // Call http_get with 2 or 3 arguments, always returns a promise.
  // Resolved value: { status: Number, body: String, headers: Object }
  // On error:       { status: 0, body: '', error: Error }
  function httpGet(url, headers) {
    return new Promise(function (resolve) {
      try {
        var result = http_get(url, headers);
        if (result && typeof result.then === 'function') {
          // Promise-based http_get
          result.then(function (r) { resolve(normalizeHttpResponse(r)); })
                .catch(function (e) { resolve({ status: 0, body: '', error: e }); });
        } else if (result && typeof result.status !== 'undefined') {
          // Synchronous return
          resolve(normalizeHttpResponse(result));
        } else {
          // Callback-based http_get (3rd arg)
          http_get(url, headers, function (r) {
            resolve(normalizeHttpResponse(r || { status: 0, body: '' }));
          });
        }
      } catch (e) {
        // Fallback to callback style
        try {
          http_get(url, headers, function (r) {
            resolve(normalizeHttpResponse(r || { status: 0, body: '' }));
          });
        } catch (e2) {
          resolve({ status: 0, body: '', error: e2 });
        }
      }
    });
  }

  function httpPost(url, headers, body) {
    return new Promise(function (resolve) {
      try {
        var result = http_post(url, headers, body);
        if (result && typeof result.then === 'function') {
          result.then(function (r) { resolve(normalizeHttpResponse(r)); })
                .catch(function (e) { resolve({ status: 0, body: '', error: e }); });
        } else if (result && typeof result.status !== 'undefined') {
          resolve(normalizeHttpResponse(result));
        } else {
          http_post(url, headers, body, function (r) {
            resolve(normalizeHttpResponse(r || { status: 0, body: '' }));
          });
        }
      } catch (e) {
        try {
          http_post(url, headers, body, function (r) {
            resolve(normalizeHttpResponse(r || { status: 0, body: '' }));
          });
        } catch (e2) {
          resolve({ status: 0, body: '', error: e2 });
        }
      }
    });
  }

  function normalizeHttpResponse(r) {
    if (!r) return { status: 0, body: '' };
    var body = (typeof r.body === 'string') ? r.body : (r.body ? JSON.stringify(r.body) : '');
    return {
      status: r.status || 0,
      body: body,
      headers: r.headers || {}
    };
  }

  // Convenience: fetch JSON
  function fetchJson(url, headers) {
    return httpGet(url, headers).then(function (res) {
      if (res.status === 0 || res.status >= 400) return null;
      try { return JSON.parse(res.body); } catch (e) { return null; }
    });
  }

  // Convenience: fetch text
  function fetchText(url, headers) {
    return httpGet(url, headers).then(function (res) {
      if (res.status === 0 || res.status >= 400) return null;
      return res.body || '';
    });
  }

  // Convenience: TMDB JSON fetch
  function tmdbFetch(path) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return fetchJson(TMDB_BASE + path + sep + 'api_key=' + TMDB_KEY, H_JSON);
  }

  // ===========================================================================
  // FETCH POLYFILL  (for provider code that uses global fetch())
  // ALWAYS installs — overrides any existing fetch with our http_get backend.
  // ===========================================================================

  (function installFetchPolyfill() {
    globalThis.fetch = function (url, opts) {
      return new Promise(function (resolve) {
        var urlStr = (typeof url === 'object' && url.url) ? url.url : String(url);
        var options = opts || {};
        var method = (options.method || 'GET').toUpperCase();

        // Merge MOBILE headers with caller headers
        var reqHeaders = {};
        for (var k in H_MOBILE) { if (H_MOBILE.hasOwnProperty(k)) reqHeaders[k] = H_MOBILE[k]; }
        var h = options.headers || {};
        if (typeof h.forEach === 'function') {
          h.forEach(function (v, k) { reqHeaders[k] = v; });
        } else {
          for (var k in h) { if (h.hasOwnProperty(k)) reqHeaders[k] = h[k]; }
        }

        function onNativeResponse(resp) {
          if (!resp) { resolve(emptyFetchResponse(urlStr)); return; }
          var bodyStr = (typeof resp.body === 'string') ? resp.body : (resp.body ? JSON.stringify(resp.body) : '');
          var ok = resp.status >= 200 && resp.status < 300;
          resolve({
            ok: ok,
            status: resp.status || (ok ? 200 : 0),
            statusText: ok ? 'OK' : 'Error',
            headers: parseRespHeaders(resp.headers),
            url: urlStr,
            redirected: false,
            json: function () { try { return Promise.resolve(JSON.parse(bodyStr)); } catch(e) { return Promise.reject(e); } },
            text: function () { return Promise.resolve(bodyStr); }
          });
        }

        try {
          if (method === 'POST') {
            http_post(urlStr, reqHeaders, options.body || '', onNativeResponse);
          } else {
            http_get(urlStr, reqHeaders, onNativeResponse);
          }
        } catch (e) {
          resolve(emptyFetchResponse(urlStr, e));
        }
      });
    };

    function emptyFetchResponse(urlStr, err) {
      var msg = err ? err.message : 'Unknown error';
      return {
        ok: false, status: 0, statusText: msg,
        headers: { get: function () { return null; }, forEach: function () {} },
        url: urlStr, redirected: false,
        json: function () { return Promise.reject(err || new Error(msg)); },
        text: function () { return Promise.resolve(''); }
      };
    }

    function parseRespHeaders(hdrs) {
      if (!hdrs || typeof hdrs !== 'object') {
        return { get: function () { return null; }, forEach: function () {} };
      }
      return {
        get: function (name) {
          var v = hdrs[name] || hdrs[name.toLowerCase()] || null;
          return Array.isArray(v) ? v[0] : v;
        },
        forEach: function (cb) {
          for (var k in hdrs) { if (hdrs.hasOwnProperty(k)) cb(hdrs[k], k); }
        }
      };
    }

    log('fetch polyfill installed (http_get backend)');
  })();

  // Polyfill global/window for provider compatibility
  if (typeof global === 'undefined') { globalThis.global = globalThis; }
  if (typeof window === 'undefined') { globalThis.window = globalThis; }
  if (typeof globalThis.self === 'undefined') { globalThis.self = globalThis; }

  // ===========================================================================
  // TIMEOUT HELPER
  // ===========================================================================

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error((label || 'Operation') + ' timed out after ' + ms + 'ms'));
      }, ms);
      promise.then(
        function (r) { clearTimeout(timer); resolve(r); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  // ===========================================================================
  // URL SCHEME: nuvio://{mediaType}/{tmdbId}[/{season}/{episode}]
  // ===========================================================================

  function makeItemUrl(tmdbId, type) {
    return 'nuvio://' + type + '/' + tmdbId;
  }

  function makeEpUrl(tmdbId, type, season, episode) {
    return 'nuvio://' + type + '/' + tmdbId + '/' + (season || 0) + '/' + (episode || 0);
  }

  function parseNuvioUrl(url) {
    if (!url || typeof url !== 'string' || url.indexOf('nuvio://') !== 0) return null;
    var parts = url.replace('nuvio://', '').split('/');
    if (parts.length < 2) return null;
    return {
      mediaType: parts[0],
      tmdbId: parts[1],
      season: parts[2] ? parseInt(parts[2], 10) || null : null,
      episode: parts[3] ? parseInt(parts[3], 10) || null : null
    };
  }

  function cacheKey(url) {
    var p = parseNuvioUrl(url);
    if (!p) return url;
    if (p.mediaType === 'movie') return 'm:' + p.tmdbId;
    return 't:' + p.tmdbId + ':' + (p.season || '0') + ':' + (p.episode || '0');
  }

  // ===========================================================================
  // IMAGE HELPERS
  // ===========================================================================

  function imgUrl(path, size) {
    return path ? IMG_BASE + '/' + (size || 'w185') + path : '';
  }

  function imgBanner(path) {
    return path ? IMG_BASE + '/w342' + path : '';
  }

  function imgStill(path) {
    return path ? IMG_BASE + '/w300' + path : '';
  }

  // ===========================================================================
  // QUALITY DETECTION
  // ===========================================================================

  var QUALITY_PATTERNS = [
    { re: /2160p|4K|UHD|2160/i, label: '4K' },
    { re: /1080p|FHD|Full\s*HD|1080/i, label: '1080p' },
    { re: /720p|HD|720/i, label: '720p' },
    { re: /480p|SD|480/i, label: '480p' },
    { re: /360p|360/i, label: '360p' }
  ];

  function detectQuality(url, name) {
    var str = (name || '') + ' ' + (url || '');
    for (var i = 0; i < QUALITY_PATTERNS.length; i++) {
      if (QUALITY_PATTERNS[i].re.test(str)) return QUALITY_PATTERNS[i].label;
    }
    return null;
  }

  // ===========================================================================
  // PLAYABLE URL DETECTION
  // ===========================================================================

  var EMBED_DOMAINS = [
    'dood.wf', 'dood.so', 'doodstream', 'd000d.com',
    'mp4upload.com', 'embasic.pro', 'rapidshare.cc',
    'mixdrop', 'streamruby', 'embeds.to', 'netmirror',
    'vidmoly', 'streamlare', 'upstream', 'filemoon'
  ];

  function isPlayable(url) {
    if (!url) return false;
    var u = url.toLowerCase();
    if (u.indexOf('.m3u8') >= 0 || u.indexOf('.m3u') >= 0) return true;
    if (u.indexOf('.mp4') >= 0) return true;
    if (u.indexOf('.mkv') >= 0) return true;
    if (u.indexOf('.webm') >= 0) return true;
    if (u.indexOf('/hls/') >= 0) return true;
    if (u.indexOf('.mpd') >= 0 || (u.indexOf('manifest') >= 0 && u.indexOf('.mpd') >= 0)) return true;
    for (var i = 0; i < EMBED_DOMAINS.length; i++) {
      if (u.indexOf(EMBED_DOMAINS[i]) >= 0) return true;
    }
    return false;
  }

  // ===========================================================================
  // PROVIDER DISCOVERY
  // ===========================================================================

  function discoverProviders() {
    if (_discoveryCache) return Promise.resolve(_discoveryCache);
    if (_discoveryPromise) return _discoveryPromise;

    _discoveryPromise = new Promise(function (resolve) {
      log('Discovering providers from ' + NUVIO_SOURCES.length + ' manifests...');

      var all = [];
      var remaining = NUVIO_SOURCES.length;
      if (remaining === 0) { _discoveryCache = []; resolve([]); return; }

      NUVIO_SOURCES.forEach(function (source) {
        fetchJson(source.url, H_JSON).then(function (manifest) {
          if (!manifest || !manifest.scrapers || !manifest.scrapers.length) {
            log('Empty manifest: ' + source.name);
            return;
          }

          var baseUrl = source.url.substring(0, source.url.lastIndexOf('/'));
          var count = 0;

          manifest.scrapers.forEach(function (scraper) {
            if (scraper.enabled === false) return;
            if (!scraper.filename) return;

            var fileUrl = scraper.filename.indexOf('http') === 0
              ? scraper.filename
              : baseUrl + '/' + scraper.filename;

            all.push({
              id: source.id + '/' + (scraper.id || scraper.name || scraper.filename),
              name: scraper.name || scraper.id || scraper.filename,
              sourceName: source.name,
              fileUrl: fileUrl,
              supportedTypes: scraper.supportedTypes || ['movie', 'tv']
            });
            count++;
          });

          log(source.name + ': ' + count + ' providers');
        }).catch(function (e) {
          log('Manifest error: ' + source.name + ' — ' + e.message);
        }).then(function () {
          remaining--;
          if (remaining <= 0) {
            log('Discovery complete: ' + all.length + ' providers');
            _discoveryCache = all;
            resolve(all);
          }
        });
      });
    });

    return _discoveryPromise;
  }

  // ===========================================================================
  // PROVIDER CODE EXECUTION  (multiple strategies)
  // ===========================================================================

  function loadProviderFn(provider) {
    if (_fnCache[provider.id]) return Promise.resolve(_fnCache[provider.id]);

    return fetchText(provider.fileUrl, H_EXTERNAL).then(function (code) {
      if (!code) { _fnCache[provider.id] = null; return null; }

      // Strip "use strict"
      code = code.replace(/^["']use strict["'];?\s*/m, '');

      var fn = tryExecStrategy1(code, provider.name)
            || tryExecStrategy2(code, provider.name)
            || tryExecStrategy3(code, provider.name);

      if (fn) {
        log('✓ ' + provider.name);
        _fnCache[provider.id] = fn;
        return fn;
      }

      log('✗ ' + provider.name);
      _fnCache[provider.id] = null;
      return null;
    }).catch(function (e) {
      log('Error loading ' + provider.name + ': ' + e.message);
      _fnCache[provider.id] = null;
      return null;
    });
  }

  function tryExecStrategy1(code, name) {
    // Strategy 1: new Function with module wrapper
    try {
      var mod = { exports: {} };
      var factory = new Function('return (function(module){' + code + '\nreturn module.exports;})')();
      var exported = factory(mod);
      if (exported && typeof exported.getStreams === 'function') return exported.getStreams;
    } catch (e) {
      // Silent
    }
    return null;
  }

  function tryExecStrategy2(code, name) {
    // Strategy 2: indirect eval with inline module
    try {
      var src = '(function(){\nvar module={exports:{}};\nvar exports=module.exports;\n' + code + '\nreturn module.exports;\n})()';
      var result = new Function('return ' + src)();
      if (result && typeof result.getStreams === 'function') return result.getStreams;
    } catch (e) {
      // Silent
    }
    return null;
  }

  function tryExecStrategy3(code, name) {
    // Strategy 3: direct eval (last resort)
    try {
      var mod3 = { exports: {} };
      (0, eval)('var module={exports:{}};var exports=module.exports;' + code);
      if (typeof module !== 'undefined' && module.exports && typeof module.exports.getStreams === 'function') {
        // Capture from non-strict eval leaking to global scope
        // This is fragile but catches edge cases
      }
      var r = new Function('return (function(m){' + code + '\nreturn m.exports||{getStreams:function(){return[]}};})')();
      var ex = r({ exports: {} });
      if (ex && typeof ex.getStreams === 'function') return ex.getStreams;
    } catch (e) {
      // Silent
    }
    return null;
  }

  // ===========================================================================
  // CALL A SINGLE PROVIDER
  // ===========================================================================

  function callProvider(fn, tmdbId, mediaType, season, episode, label) {
    return withTimeout(
      fn(tmdbId, mediaType, season, episode),
      PROVIDER_TIMEOUT,
      label
    ).then(function (result) {
      return Array.isArray(result) ? result : [];
    }).catch(function () {
      return [];
    });
  }

  // ===========================================================================
  // STREAM FETCHING PIPELINE
  // ===========================================================================

  function sortByScore(providers) {
    return providers.slice().sort(function (a, b) {
      var sa = _providerScore[a.id] || 0;
      var sb = _providerScore[b.id] || 0;
      if (sa !== sb) return sb - sa;
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  function fetchStreams(tmdbId, mediaType, season, episode) {
    var startTime = Date.now();

    return discoverProviders().then(function (providers) {
      if (!providers || providers.length === 0) return [];

      // Filter by media type
      var valid = providers.filter(function (p) {
        var types = p.supportedTypes || ['movie', 'tv'];
        return types.indexOf(mediaType) >= 0;
      });
      if (valid.length === 0) return [];

      // Sort by score (reliable providers first)
      valid = sortByScore(valid);

      var allStreams = [];

      // Process in parallel batches with early exit
      function processBatch(idx) {
        if (idx >= valid.length || allStreams.length >= EARLY_EXIT_STREAMS) {
          return deduplicate(allStreams).then(function (unique) {
            var elapsed = (Date.now() - startTime) + 'ms';
            log('Scraped ' + unique.length + ' streams from ' + valid.length + ' providers in ' + elapsed);
            return unique;
          });
        }

        var batch = valid.slice(idx, idx + BATCH_SIZE);

        return Promise.allSettled(batch.map(function (pr) {
          return loadProviderFn(pr).then(function (fn) {
            if (!fn) return [];
            return callProvider(fn, tmdbId, mediaType, season, episode, pr.name).then(function (streams) {
              if (!Array.isArray(streams) || streams.length === 0) return [];

              // Score this provider for future queries
              _providerScore[pr.id] = (_providerScore[pr.id] || 0) + streams.length;

              // Map to StreamResult with provider name
              return streams.map(function (s) {
                if (!s || !s.url) return null;
                if (!isPlayable(s.url) && (!s.headers || Object.keys(s.headers).length === 0)) return null;

                var qual = s.quality || detectQuality(s.url, s.name) || 'Auto';
                var label = pr.name;
                if (qual && qual !== 'Auto') label += ' • ' + qual;
                if (s.size) label += ' • ' + s.size;

                return new StreamResult({
                  url: s.url,
                  name: pr.sourceName + ' › ' + pr.name + (s.name ? ' — ' + s.name : ''),
                  source: label,
                  quality: qual,
                  headers: s.headers || {},
                  subtitles: s.subtitles || undefined
                });
              }).filter(function (s) { return s !== null; });
            });
          });
        })).then(function (results) {
          results.forEach(function (r) {
            if (r.status === 'fulfilled' && Array.isArray(r.value)) {
              allStreams = allStreams.concat(r.value);
            }
          });
          return processBatch(idx + BATCH_SIZE);
        });
      }

      return processBatch(0);
    });
  }

  function deduplicate(streams) {
    try {
      var seen = {};
      var unique = [];
      streams.forEach(function (s) {
        if (!s || !s.url) return;
        var key = s.url;
        if (!seen[key]) { seen[key] = true; unique.push(s); }
      });
      return Promise.resolve(unique);
    } catch (e) {
      return Promise.resolve(streams || []);
    }
  }

  // ===========================================================================
  // TMDB → MultimediaItem
  // ===========================================================================

  function tmdbToItem(d, type) {
    var title = type === 'tv' ? d.name : d.title;
    var date = type === 'tv' ? d.first_air_date : d.release_date;
    var year = date ? parseInt(date.substring(0, 4), 10) : undefined;

    return new MultimediaItem({
      title: title || 'Unknown',
      url: makeItemUrl(d.id, type),
      posterUrl: imgUrl(d.poster_path),
      type: type === 'tv' ? 'series' : 'movie',
      year: year,
      score: d.vote_average || undefined,
      description: d.overview || '',
      bannerUrl: imgBanner(d.backdrop_path),
      logoUrl: '',
      cast: [],
      trailers: []
    });
  }

  // ===========================================================================
  // CORE PLUGIN FUNCTIONS
  // ===========================================================================

  // ----- getHome (10+ categories) -----
  function getHome(cb) {
    log('getHome');

    Promise.all([
      tmdbFetch('/trending/movie/week').then(function (r) { return { key: 'Trending Movies', data: r }; }),
      tmdbFetch('/trending/tv/week').then(function (r) { return { key: 'Trending TV Shows', data: r }; }),
      tmdbFetch('/movie/popular').then(function (r) { return { key: 'Popular Movies', data: r }; }),
      tmdbFetch('/tv/popular').then(function (r) { return { key: 'Popular TV Shows', data: r }; }),
      tmdbFetch('/movie/top_rated').then(function (r) { return { key: 'Top Rated Movies', data: r }; }),
      tmdbFetch('/tv/top_rated').then(function (r) { return { key: 'Top Rated TV Shows', data: r }; }),
      tmdbFetch('/movie/now_playing').then(function (r) { return { key: 'Now Playing', data: r }; }),
      tmdbFetch('/tv/airing_today').then(function (r) { return { key: 'Airing Today', data: r }; }),
      tmdbFetch('/movie/upcoming').then(function (r) { return { key: 'Upcoming', data: r }; }),
      tmdbFetch('/trending/all/week').then(function (r) { return { key: 'Trending Now', data: r }; })
    ]).then(function (results) {
      var data = {};
      var allTrending = [];

      results.forEach(function (result) {
        if (!result || !result.data || !result.data.results) return;
        var items = result.data.results.slice(0, MAX_HOME_ITEMS).map(function (item) {
          var t = item.media_type || (result.key.indexOf('TV') >= 0 || result.key.indexOf('Airing') >= 0 || result.key.indexOf('Shows') >= 0 ? 'tv' : 'movie');
          if (result.key === 'Trending Now') {
            t = item.media_type === 'tv' ? 'tv' : 'movie';
          }
          return tmdbToItem(item, t);
        });
        if (items.length > 0) {
          data[result.key] = items;
          if (result.key.indexOf('Trending') >= 0) {
            allTrending = allTrending.concat(items);
          }
        }
      });

      // Hero carousel
      if (allTrending.length > 0) {
        data['Trending'] = allTrending.slice(0, 12);
      }

      // Warm provider cache in background
      discoverProviders().catch(function () {});

      log('getHome: ' + Object.keys(data).length + ' categories');
      cb({ success: true, data: data });
    }).catch(function (e) {
      log('getHome error: ' + e.message);
      cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message });
    });
  }

  // ----- search -----
  function search(query, cb) {
    log('search: "' + query + '"');

    Promise.all([
      tmdbFetch('/search/movie?query=' + encodeURIComponent(query)),
      tmdbFetch('/search/tv?query=' + encodeURIComponent(query))
    ]).then(function (results) {
      var movies = results[0];
      var tv = results[1];
      var combined = [];

      if (movies && movies.results) {
        movies.results.slice(0, 10).forEach(function (m) { combined.push(tmdbToItem(m, 'movie')); });
      }
      if (tv && tv.results) {
        tv.results.slice(0, 10).forEach(function (t) { combined.push(tmdbToItem(t, 'tv')); });
      }

      cb({ success: true, data: combined });
    }).catch(function (e) {
      log('search error: ' + e.message);
      cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message });
    });
  }

  // ----- load -----
  function load(url, cb) {
    log('load: ' + url);

    var p = parseNuvioUrl(url);
    if (!p) return cb({ success: false, errorCode: 'BAD_REQUEST', message: 'Invalid URL' });

    if (p.mediaType === 'movie') {
      tmdbFetch('/movie/' + p.tmdbId).then(function (d) {
        if (!d) return cb({ success: false, errorCode: 'NOT_FOUND' });
        cb({ success: true, data: tmdbToItem(d, 'movie') });
      }).catch(function (e) {
        log('load movie error: ' + e.message);
        cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message });
      });

    } else if (p.mediaType === 'tv') {
      Promise.all([
        tmdbFetch('/tv/' + p.tmdbId),
        tmdbFetch('/tv/' + p.tmdbId + '/season/1'),
        tmdbFetch('/tv/' + p.tmdbId + '/season/2'),
        tmdbFetch('/tv/' + p.tmdbId + '/season/3'),
        tmdbFetch('/tv/' + p.tmdbId + '/season/4'),
        tmdbFetch('/tv/' + p.tmdbId + '/season/5')
      ]).then(function (results) {
        var tvData = results[0];
        if (!tvData) return cb({ success: false, errorCode: 'NOT_FOUND' });

        var item = tmdbToItem(tvData, 'tv');
        var episodes = [];

        for (var s = 1; s <= 5; s++) {
          var seasonData = results[s];
          if (!seasonData || !seasonData.episodes) continue;

          seasonData.episodes.forEach(function (ep) {
            episodes.push(new Episode({
              name: 'S' + pad(seasonData.season_number, 2) + 'E' + pad(ep.episode_number, 2) + ' - ' + (ep.name || ''),
              url: makeEpUrl(p.tmdbId, 'tv', seasonData.season_number, ep.episode_number),
              season: seasonData.season_number,
              episode: ep.episode_number,
              rating: ep.vote_average,
              runtime: ep.runtime,
              airDate: ep.air_date || '',
              thumbnail: imgStill(ep.still_path)
            }));
          });
        }

        item.episodes = episodes;
        log('load: ' + episodes.length + ' episodes');
        cb({ success: true, data: item });
      }).catch(function (e) {
        log('load tv error: ' + e.message);
        cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message });
      });

    } else {
      cb({ success: false, errorCode: 'BAD_REQUEST', message: 'Unknown type: ' + p.mediaType });
    }
  }

  // ----- loadStreams (cached, massively parallel) -----
  function loadStreams(url, cb) {
    log('loadStreams: ' + url);

    var p = parseNuvioUrl(url);
    if (!p) return cb({ success: false, errorCode: 'BAD_REQUEST' });

    var key = cacheKey(url);
    log('Streams: ' + key);

    // Memory cache hit
    var cached = _streamCache[key];
    if (cached) {
      log('Cache hit: ' + cached.length + ' streams');
      return cb({ success: true, data: cached });
    }

    fetchStreams(p.tmdbId, p.mediaType, p.season, p.episode).then(function (streams) {
      _streamCache[key] = streams;
      log('Returning ' + streams.length + ' streams');
      cb({ success: true, data: streams });
    }).catch(function (e) {
      log('loadStreams error: ' + e.message);
      cb({ success: true, data: [] });
    });
  }

  // ===========================================================================
  // UTILITY
  // ===========================================================================

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  // ===========================================================================
  // EXPORTS
  // ===========================================================================

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;

  log('Plugin v4 loaded — ' + NUVIO_SOURCES.length + ' Nuvio sources');
})();