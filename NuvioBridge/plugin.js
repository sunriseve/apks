(function () {
  // ===========================================================================
  // NUVIO BRIDGE — SkyStream Plugin v1.0.0
  // Dynamically discovers and loads ALL Nuvio streaming providers at runtime.
  // Uses TMDB API for metadata (search, browse, episode listing).
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // CONFIGURATION — Edit this list to add/remove Nuvio manifest sources
  // ---------------------------------------------------------------------------
  var NUVIO_SOURCES = [
    {
      id: 'yoruix',
      name: "Yoru's Nuvio",
      url: 'https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json'
    },
    {
      id: 'd3adlyrocket',
      name: 'D3adlyRocket',
      url: 'https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json'
    },
    {
      id: 'phisher98',
      name: 'Phisher98',
      url: 'https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/refs/heads/main/manifest.json'
    },
    {
      id: 'michat88',
      name: 'Michat88',
      url: 'https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main/manifest.json'
    },
    {
      id: 'piratezoro9',
      name: "Kabir's Providers",
      url: 'https://raw.githubusercontent.com/PirateZoro9/nuvio-kabir-providers/refs/heads/main/manifest.json'
    },
    {
      id: 'hihihihiray',
      name: "Ray's Plugins",
      url: 'https://raw.githubusercontent.com/hihihihihiiray/plugins/refs/heads/main/manifest.json'
    }
  ];

  // ---------------------------------------------------------------------------
  // CONSTANTS
  // ---------------------------------------------------------------------------
  var TAG = 'NuvioBridge';
  var TMDB_KEY = '68e094699525b18a70bab2f86b1fa706';
  var TMDB_BASE = 'https://api.themoviedb.org/3';
  var IMG_BASE = 'https://image.tmdb.org/t/p';

  // User-Agent strings for different contexts
  var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  var EXTERNAL_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive'
  };
  var MOBILE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.134 Mobile Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  var UA = USER_AGENT; // legacy alias

  // Provider cache (discovered providers + loaded getStreams functions)
  var _discoveryCache = null;
  var _discoveryPromise = null;
  var _fnCache = {};

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------
  function log(msg) {
    try { console.log('[' + TAG + '] ' + msg); } catch (e) {}
  }

  function warn(msg) {
    try { console.warn('[' + TAG + '] ' + msg); } catch (e) {}
  }

  function jsonFetch(url, opts) {
    try {
      if (!url || typeof fetch !== 'function') return Promise.resolve(null);
      opts = opts || {};
      var headers = {};
      // Start with EXTERNAL_HEADERS, override Accept for JSON
      for (var k in EXTERNAL_HEADERS) { headers[k] = EXTERNAL_HEADERS[k]; }
      headers['Accept'] = 'application/json';
      if (opts.headers) {
        for (var k in opts.headers) {
          headers[k] = opts.headers[k];
        }
      }
      return fetch(url, { headers: headers, method: opts.method, body: opts.body }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function (e) {
        log('Fetch error: ' + String(url).slice(0, 80) + ' — ' + e.message);
        return null;
      });
    } catch (e) {
      log('jsonFetch fatal: ' + e.message);
      return Promise.resolve(null);
    }
  }

  function textFetch(url, opts) {
    try {
      if (!url || typeof fetch !== 'function') return Promise.resolve(null);
      opts = opts || {};
      var headers = {};
      for (var k in EXTERNAL_HEADERS) { headers[k] = EXTERNAL_HEADERS[k]; }
      if (opts.headers) {
        for (var k in opts.headers) {
          headers[k] = opts.headers[k];
        }
      }
      return fetch(url, { headers: headers, method: opts.method, body: opts.body }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).catch(function (e) {
        log('Text fetch error: ' + String(url).slice(0, 80) + ' — ' + e.message);
        return null;
      });
    } catch (e) {
      log('textFetch fatal: ' + e.message);
      return Promise.resolve(null);
    }
  }

  function tmdb(path) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return jsonFetch(TMDB_BASE + path + sep + 'api_key=' + TMDB_KEY);
  }

  function img(path, size) {
    size = size || 'w185';
    return path ? IMG_BASE + '/' + size + path : '';
  }

  function imgStill(path) {
    return path ? IMG_BASE + '/w300' + path : '';
  }

  // ---------------------------------------------------------------------------
  // FETCH POLYFILL — provides fetch() using SkyStream native http_get/http_post
  // when the standard fetch is not available.
  // ---------------------------------------------------------------------------
  if (typeof globalThis.fetch === 'undefined') {
    if (typeof http_get === 'function') {
      globalThis.fetch = function (url, opts) {
        return new Promise(function (resolve) {
          var urlStr = (typeof url === 'object' && url.url) ? url.url : String(url);
          var options = opts || {};
          var method = (options.method || 'GET').toUpperCase();

          // Merge caller headers with MOBILE_HEADERS as defaults
          var reqHeaders = {};
          for (var k in MOBILE_HEADERS) { reqHeaders[k] = MOBILE_HEADERS[k]; }
          if (options.headers) {
            if (typeof options.headers.forEach === 'function') {
              options.headers.forEach(function (v, k) { reqHeaders[k] = v; });
            } else {
              for (var k in options.headers) {
                if (Object.prototype.hasOwnProperty.call(options.headers, k)) {
                  reqHeaders[k] = options.headers[k];
                }
              }
            }
          }

          function onResponse(resp) {
            var bodyStr = typeof resp.body === 'string' ? resp.body : (resp.body ? JSON.stringify(resp.body) : '');
            var ok = resp.status >= 200 && resp.status < 300;
            resolve({
              ok: ok,
              status: resp.status || 200,
              statusText: ok ? 'OK' : 'Error',
              headers: { get: function () { return null; }, forEach: function () {} },
              url: urlStr, redirected: false,
              json: function () { return Promise.resolve(JSON.parse(bodyStr)); },
              text: function () { return Promise.resolve(bodyStr); }
            });
          }

          try {
            if (method === 'POST') { http_post(urlStr, reqHeaders, options.body || '', onResponse); }
            else { http_get(urlStr, reqHeaders, onResponse); }
          } catch (e) {
            resolve({
              ok: false, status: 0, statusText: e.message,
              headers: { get: function () { return null; }, forEach: function () {} },
              url: urlStr, redirected: false,
              json: function () { return Promise.reject(e); },
              text: function () { return Promise.resolve(''); }
            });
          }
        });
      };
    }
    log('fetch polyfill installed (http_get backend)');
  }

  // Polyfill global/window for provider compatibility
  if (typeof global === 'undefined') { globalThis.global = globalThis; }
  if (typeof window === 'undefined') { globalThis.window = globalThis; }

  // ---------------------------------------------------------------------------
  // URL SCHEME: nuvio://{mediaType}/{tmdbId}[/{season}/{episode}]
  // ---------------------------------------------------------------------------
  function itemUrl(tmdbId, type) {
    return 'nuvio://' + type + '/' + tmdbId;
  }

  function epUrl(tmdbId, type, season, episode) {
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

  // ---------------------------------------------------------------------------
  // PROVIDER DISCOVERY — fetch all Nuvio manifests, extract provider metadata
  // ---------------------------------------------------------------------------
  function discoverProviders() {
    if (_discoveryCache) return Promise.resolve(_discoveryCache);
    if (_discoveryPromise) return _discoveryPromise;

    _discoveryPromise = new Promise(function (resolve) {
      log('Discovering Nuvio providers from ' + NUVIO_SOURCES.length + ' manifests...');

      var all = [];
      var remaining = NUVIO_SOURCES.length;

      if (remaining === 0) {
        _discoveryCache = [];
        resolve([]);
        return;
      }

      NUVIO_SOURCES.forEach(function (source) {
        jsonFetch(source.url).then(function (manifest) {
          if (!manifest || !manifest.scrapers || !manifest.scrapers.length) {
            log('Empty manifest: ' + source.name);
            return;
          }

          var baseUrl = source.url.substring(0, source.url.lastIndexOf('/'));
          var count = 0;

          manifest.scrapers.forEach(function (scraper) {
            // Skip disabled providers
            if (scraper.enabled === false) return;

            var fileUrl;
            if (scraper.filename && scraper.filename.indexOf('http') === 0) {
              fileUrl = scraper.filename;
            } else if (scraper.filename) {
              fileUrl = baseUrl + '/' + scraper.filename;
            } else {
              return;
            }

            all.push({
              id: source.id + '/' + scraper.id,
              name: scraper.name || scraper.id,
              sourceName: source.name,
              fileUrl: fileUrl,
              supportedTypes: scraper.supportedTypes || ['movie', 'tv']
            });
            count++;
          });

          log(source.name + ': found ' + count + ' providers');
        }).catch(function (e) {
          log('Failed manifest ' + source.name + ': ' + e.message);
        }).then(function () {
          remaining--;
          if (remaining <= 0) {
            log('Discovery complete: ' + all.length + ' total providers');
            _discoveryCache = all;
            resolve(all);
          }
        });
      });
    });

    return _discoveryPromise;
  }

  // ---------------------------------------------------------------------------
  // PROVIDER CODE EXECUTION — fetch & safely evaluate provider JS at runtime
  // ---------------------------------------------------------------------------
  function loadProviderFn(provider) {
    if (_fnCache[provider.id]) return Promise.resolve(_fnCache[provider.id]);

    return textFetch(provider.fileUrl).then(function (code) {
      if (!code) {
        _fnCache[provider.id] = null;
        return null;
      }

      // Strip "use strict" from module code to avoid strict-mode restrictions
      var cleanCode = code.replace(/^["']use strict["'];?\s*/m, '');

      // Strategy 1: new Function with mock module.exports
      try {
        var mod = { exports: {} };
        var body = '(function(module) {\n' + cleanCode + '\nreturn module.exports;\n})';
        var factory = new Function('return ' + body)();
        var exported = factory(mod);
        if (exported && typeof exported.getStreams === 'function') {
          log('✓ Loaded: ' + provider.name);
          _fnCache[provider.id] = exported.getStreams;
          return exported.getStreams;
        }
      } catch (e1) {
        log('Exec strategy 1 failed for ' + provider.name + ': ' + e1.message);
      }

      // Strategy 2: indirect eval fallback
      try {
        var mod2 = { exports: {} };
        var src = '(function(){\nvar module={exports:{}};\nvar exports=module.exports;\n' + cleanCode + '\nreturn module.exports;\n})()';
        var result = new Function('return ' + src)();
        if (result && typeof result.getStreams === 'function') {
          log('✓ Loaded (eval): ' + provider.name);
          _fnCache[provider.id] = result.getStreams;
          return result.getStreams;
        }
      } catch (e2) {
        log('Exec strategy 2 failed for ' + provider.name + ': ' + e2.message);
      }

      log('✗ Failed to load: ' + provider.name);
      _fnCache[provider.id] = null;
      return null;
    }).catch(function (e) {
      log('Error loading ' + provider.name + ': ' + e.message);
      _fnCache[provider.id] = null;
      return null;
    });
  }

  // ---------------------------------------------------------------------------
  // TMDB → MultimediaItem mapping
  // ---------------------------------------------------------------------------
  function tmdbToItem(data, mediaType) {
    var title = mediaType === 'tv' ? data.name : data.title;
    var date = mediaType === 'tv' ? data.first_air_date : data.release_date;
    var year = date ? parseInt(date.substring(0, 4), 10) : undefined;

    return new MultimediaItem({
      title: title || 'Unknown',
      url: itemUrl(data.id, mediaType),
      posterUrl: img(data.poster_path),
      type: mediaType === 'tv' ? 'series' : 'movie',
      year: year,
      score: data.vote_average || undefined,
      description: data.overview || '',
      bannerUrl: img(data.backdrop_path, 'w342'),
      logoUrl: '',
      cast: [],
      trailers: []
    });
  }

  // ---------------------------------------------------------------------------
  // CORE PLUGIN FUNCTIONS
  // ---------------------------------------------------------------------------

  // ----- getHome -----
  function getHome(cb) {
    log('getHome');

    Promise.all([
      tmdb('/trending/movie/week'),
      tmdb('/trending/tv/week')
    ]).then(function (results) {
      var movieTrending = results[0];
      var tvTrending = results[1];
      var data = {};
      var allTrending = [];

      if (movieTrending && movieTrending.results) {
        var items = movieTrending.results.slice(0, 20).map(function (m) {
          return tmdbToItem(m, 'movie');
        });
        data['Trending Movies'] = items;
        allTrending = allTrending.concat(items);
      }

      if (tvTrending && tvTrending.results) {
        var items2 = tvTrending.results.slice(0, 20).map(function (t) {
          return tmdbToItem(t, 'tv');
        });
        data['Trending TV Shows'] = items2;
        allTrending = allTrending.concat(items2);
      }

      // Use first 10 items as the hero carousel ("Trending")
      if (allTrending.length > 0) {
        data['Trending'] = allTrending.slice(0, 10);
      }

      // Warm provider cache in background
      discoverProviders().catch(function () {});

      log('getHome done: ' + Object.keys(data).length + ' categories');
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
      tmdb('/search/movie?query=' + encodeURIComponent(query)),
      tmdb('/search/tv?query=' + encodeURIComponent(query))
    ]).then(function (results) {
      var movies = results[0];
      var tv = results[1];
      var combined = [];

      if (movies && movies.results) {
        movies.results.slice(0, 10).forEach(function (m) {
          combined.push(tmdbToItem(m, 'movie'));
        });
      }
      if (tv && tv.results) {
        tv.results.slice(0, 10).forEach(function (t) {
          combined.push(tmdbToItem(t, 'tv'));
        });
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

    var parsed = parseNuvioUrl(url);
    if (!parsed) {
      return cb({ success: false, errorCode: 'BAD_REQUEST', message: 'Invalid URL: ' + url });
    }

    var tmdbId = parsed.tmdbId;
    var mediaType = parsed.mediaType;

    if (mediaType === 'movie') {
      tmdb('/movie/' + tmdbId).then(function (data) {
        if (!data) {
          return cb({ success: false, errorCode: 'NOT_FOUND', message: 'Movie not found' });
        }
        cb({ success: true, data: tmdbToItem(data, 'movie') });
      }).catch(function (e) {
        log('load movie error: ' + e.message);
        cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message });
      });
    } else if (mediaType === 'tv') {
      Promise.all([
        tmdb('/tv/' + tmdbId),
        tmdb('/tv/' + tmdbId + '/season/1'),
        tmdb('/tv/' + tmdbId + '/season/2'),
        tmdb('/tv/' + tmdbId + '/season/3'),
        tmdb('/tv/' + tmdbId + '/season/4'),
        tmdb('/tv/' + tmdbId + '/season/5')
      ]).then(function (results) {
        var tvData = results[0];
        if (!tvData) {
          return cb({ success: false, errorCode: 'NOT_FOUND', message: 'TV show not found' });
        }

        var item = tmdbToItem(tvData, 'tv');
        var episodes = [];

        // Process up to 5 seasons starting from season 1
        for (var s = 1; s <= 5; s++) {
          var seasonData = results[s];
          if (seasonData && seasonData.episodes) {
            seasonData.episodes.forEach(function (ep) {
              episodes.push(new Episode({
                name: 'S' + pad(seasonData.season_number, 2) + 'E' + pad(ep.episode_number, 2) + ' - ' + (ep.name || ''),
                url: epUrl(tmdbId, 'tv', seasonData.season_number, ep.episode_number),
                season: seasonData.season_number,
                episode: ep.episode_number,
                rating: ep.vote_average,
                runtime: ep.runtime,
                airDate: ep.air_date || '',
                thumbnail: imgStill(ep.still_path)
              }));
            });
          }
        }

        item.episodes = episodes;
        log('load tv: ' + episodes.length + ' episodes across 5 seasons');
        cb({ success: true, data: item });
      }).catch(function (e) {
        log('load tv error: ' + e.message);
        cb({ success: false, errorCode: 'INTERNAL_ERROR', message: e.message });
      });
    } else {
      cb({ success: false, errorCode: 'BAD_REQUEST', message: 'Unknown type: ' + mediaType });
    }
  }

  // ----- loadStreams -----
  function loadStreams(url, cb) {
    log('loadStreams: ' + url);

    var parsed = parseNuvioUrl(url);
    if (!parsed) {
      return cb({ success: false, errorCode: 'BAD_REQUEST', message: 'Invalid URL' });
    }

    var tmdbId = parsed.tmdbId;
    var mediaType = parsed.mediaType;
    var season = parsed.season;
    var episode = parsed.episode;
    log('Streams for TMDB:' + tmdbId + ' ' + mediaType + (season ? ' S' + season + 'E' + episode : ''));

    // Phase 1: discover providers
    discoverProviders().then(function (providers) {
      if (!providers || providers.length === 0) {
        return cb({ success: true, data: [] });
      }

      // Filter by supported types
      var valid = providers.filter(function (p) {
        var types = p.supportedTypes || ['movie', 'tv'];
        return types.indexOf(mediaType) >= 0 || types.indexOf('movie') >= 0 || types.indexOf('tv') >= 0;
      });

      log('Attempting ' + valid.length + ' providers for ' + mediaType);

      if (valid.length === 0) {
        return cb({ success: true, data: [] });
      }

      // Phase 2: load provider code concurrently (batched)
      var CONCURRENT = 5;
      var allStreams = [];
      var idx = 0;

      function processBatch() {
        if (idx >= valid.length) {
          log('Total streams: ' + allStreams.length);
          return cb({ success: true, data: allStreams });
        }

        var batch = valid.slice(idx, idx + CONCURRENT);
        idx += CONCURRENT;

        var promises = batch.map(function (provider) {
          return loadProviderFn(provider).then(function (getStreamsFn) {
            if (!getStreamsFn) return [];

            return getStreamsFn(tmdbId, mediaType, season, episode).then(function (nuvioStreams) {
              if (!Array.isArray(nuvioStreams)) return [];

              return nuvioStreams.map(function (s) {
                // Build display label: "ProviderName • quality • size"
                var labelParts = [provider.name];
                var qual = s.quality || '';
                if (qual && qual !== 'Auto') labelParts.push(qual);
                var sz = s.size || '';
                if (sz) labelParts.push(sz);

                return new StreamResult({
                  url: s.url,
                  quality: qual || 'Auto',
                  source: labelParts.join(' • '),
                  headers: s.headers || {},
                  name: provider.sourceName + ' › ' + provider.name + (s.name ? ' — ' + s.name : ''),
                  subtitles: s.subtitles || undefined
                });
              });
            }).catch(function (e) {
              log('Provider ' + provider.name + ' error: ' + e.message);
              return [];
            });
          });
        });

        return Promise.all(promises).then(function (results) {
          results.forEach(function (streams) {
            if (streams && streams.length) {
              allStreams.push.apply(allStreams, streams);
            }
          });
          return processBatch();
        });
      }

      processBatch();
    }).catch(function (e) {
      log('loadStreams fatal: ' + e.message);
      cb({ success: true, data: [] });
    });
  }

  // ---------------------------------------------------------------------------
  // UTILITY
  // ---------------------------------------------------------------------------
  function pad(n, width) {
    var s = String(n);
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  // ---------------------------------------------------------------------------
  // EXPORT — register global handlers for SkyStream
  // ---------------------------------------------------------------------------
  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;

  log('Plugin loaded. ' + NUVIO_SOURCES.length + ' Nuvio sources configured.');
})();
