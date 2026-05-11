(function() {
    // =========================================================================
    // Nuvio Bridge v3 — SkyStream Plugin
    // Dynamically discovers 150+ Nuvio providers from manifest URLs.
    // No hardcoded scrapers — everything comes from manifests.
    // =========================================================================

    // --- Constants ---
    var TAG = "NuvioBridge";
    var TMDB_KEY = "68e094699525b18a70bab2f86b1fa706";
    var TMDB_BASE = "https://api.themoviedb.org/3";
    var IMG_BASE = "https://image.tmdb.org/t/p";
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    var HEADERS = { "User-Agent": UA, "Accept": "application/json" };

    // Performance tuning
    var FETCH_CODE_TIMEOUT = 6000;    // 6s to download provider code
    var PROVIDER_TIMEOUT = 8000;      // 8s for a provider's getStreams call
    var BATCH_SIZE = 20;              // Providers per parallel batch
    var EARLY_EXIT_STREAMS = 20;      // Stop once we have this many streams
    var MAX_HOME_ITEMS = 20;          // Items per home category

    // Fallback manifests
    var FALLBACK_MANIFESTS = [
        "https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/D3adlyRocket/All-in-One-Nuvio/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/phisher98/phisher-nuvio-providers/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/michat88/nuvio-providers/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/PirateZoro9/nuvio-kabir-providers/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/hihihihihiiray/plugins/refs/heads/main/manifest.json",
        "https://raw.githubusercontent.com/Abinanthankv/NuvioRepo/refs/heads/master/manifest.json"
    ];

    // --- Caches ---
    var _providers = null;             // All discovered providers
    var _fnCache = {};                 // Compiled getStreams functions (memory)
    var _streamCache = {};             // Cached streams by cacheKey
    var _providerScore = {};           // Tracks provider reliability (higher = better)

    // =========================================================================
    // HELPERS
    // =========================================================================

    function log(msg) { console.log("[" + TAG + "] " + msg); }

    function withTimeout(promise, ms, label) {
        return new Promise(function(resolve, reject) {
            var timer = setTimeout(function() {
                reject(new Error((label || "Operation") + " timed out after " + ms + "ms"));
            }, ms);
            promise.then(function(r) { clearTimeout(timer); resolve(r); },
                         function(e) { clearTimeout(timer); reject(e); });
        });
    }

    async function fetchJson(url, headers) {
        var h = Object.assign({}, HEADERS, headers || {});
        var res = await http_get(url, h);
        if (!res) throw new Error("Empty response");
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        var body = res.body;
        if (typeof body === "string") return JSON.parse(body);
        return body;
    }

    async function fetchText(url, headers) {
        var h = Object.assign({}, HEADERS, headers || {});
        var res = await http_get(url, h);
        if (!res) throw new Error("Empty response");
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        return res.body || "";
    }

    function tmdbUrl(path) {
        var sep = path.indexOf("?") >= 0 ? "&" : "?";
        return TMDB_BASE + path + sep + "api_key=" + TMDB_KEY;
    }

    async function tmdbFetch(path) {
        return fetchJson(tmdbUrl(path));
    }

    function imgUrl(path, size) {
        return path ? IMG_BASE + "/" + (size || "w500") + path : "";
    }

    // =========================================================================
    // FETCH POLYFILL (for Nuvio providers that use fetch() in SkyStream sandbox)
    // =========================================================================

    if (typeof globalThis.fetch === "undefined") {
        globalThis.fetch = function(url, opts) {
            return new Promise(function(resolve, reject) {
                var urlStr = (typeof url === "object" && url.url) ? url.url : String(url);
                var options = opts || {};
                var method = (options.method || "GET").toUpperCase();
                var reqHeaders = {};

                var h = options.headers || {};
                if (typeof h.forEach === "function") {
                    h.forEach(function(v, k) { reqHeaders[k] = v; });
                } else if (typeof h === "object") {
                    for (var k in h) {
                        if (Object.prototype.hasOwnProperty.call(h, k)) {
                            reqHeaders[k] = h[k];
                        }
                    }
                }

                function onResponse(resp) {
                    var bodyStr = typeof resp.body === "string" ? resp.body :
                                  (resp.body ? JSON.stringify(resp.body) : "");
                    var ok = resp.status >= 200 && resp.status < 300;

                    resolve({
                        ok: ok,
                        status: resp.status,
                        statusText: resp.status === 200 ? "OK" : "Error",
                        headers: (resp.headers && typeof resp.headers === "object") ? {
                            get: function(name) {
                                if (!resp.headers) return null;
                                var val = resp.headers[name] || resp.headers[name.toLowerCase()] || null;
                                return Array.isArray(val) ? val[0] : val;
                            },
                            forEach: function(cb) {
                                if (!resp.headers) return;
                                for (var k in resp.headers) {
                                    if (Object.prototype.hasOwnProperty.call(resp.headers, k)) {
                                        cb(resp.headers[k], k);
                                    }
                                }
                            }
                        } : {
                            get: function() { return null; },
                            forEach: function() {}
                        },
                        url: urlStr,
                        redirected: false,
                        type: "basic",
                        json: function() { return Promise.resolve(JSON.parse(bodyStr)); },
                        text: function() { return Promise.resolve(bodyStr); },
                        blob: function() { return Promise.resolve(bodyStr); }
                    });
                }

                try {
                    if (method === "GET") {
                        http_get(urlStr, reqHeaders, onResponse);
                    } else if (method === "POST") {
                        http_post(urlStr, reqHeaders, options.body || "", onResponse);
                    } else {
                        http_get(urlStr, reqHeaders, onResponse);
                    }
                } catch(e) {
                    resolve({
                        ok: false, status: 0, statusText: e.message,
                        headers: { get: function() { return null; }, forEach: function() {} },
                        url: urlStr, redirected: false, type: "error",
                        json: function() { return Promise.reject(e); },
                        text: function() { return Promise.resolve(""); },
                        blob: function() { return Promise.resolve(""); }
                    });
                }
            });
        };
    }

    if (typeof global === "undefined") { globalThis.global = globalThis; }
    if (typeof window === "undefined") { globalThis.window = globalThis; }

    // =========================================================================
    // URL SCHEME
    // Movies:  {"i":550,"t":"movie"}             (no s/e — play button works)
    // TV show: {"i":76479,"t":"tv"}              (no s/e — load fetches episodes)
    // TV ep:   {"i":1399,"t":"tv","s":1,"e":2}   (s/e present — specific episode)
    // =========================================================================

    function makeUrl(tmdbId, type, season, episode) {
        var obj = { i: tmdbId, t: type };
        if (season > 0) obj.s = season;
        if (episode > 0) obj.e = episode;
        return JSON.stringify(obj);
    }

    function parseUrl(url) {
        try {
            var d = JSON.parse(url);
            return {
                tmdbId: d.i,
                mediaType: d.t,
                season: d.s > 0 ? d.s : null,
                episode: d.e > 0 ? d.e : null
            };
        } catch(e) { return null; }
    }

    function cacheKey(url) {
        var p = parseUrl(url);
        if (!p) return url;
        if (p.mediaType === "movie") return "m:" + p.tmdbId;
        return "t:" + p.tmdbId + ":" + (p.season || "0") + ":" + (p.episode || "0");
    }

    // =========================================================================
    // QUALITY DETECTION (parse from filename/URL)
    // =========================================================================

    var QUALITY_PATTERNS = [
        { re: /2160p|4K|UHD|2160/i, label: "4K" },
        { re: /1080p|FHD|Full\s*HD|1080/i, label: "1080p" },
        { re: /720p|HD|720/i, label: "720p" },
        { re: /480p|SD|480/i, label: "480p" },
        { re: /360p|360/i, label: "360p" }
    ];

    function detectQuality(url, name) {
        var str = (name || "") + " " + (url || "");
        for (var i = 0; i < QUALITY_PATTERNS.length; i++) {
            if (QUALITY_PATTERNS[i].re.test(str)) return QUALITY_PATTERNS[i].label;
        }
        return null;
    }

    function isPlayableUrl(url) {
        if (!url) return false;
        var u = url.toLowerCase();
        // Direct playable extensions
        if (u.indexOf(".m3u8") >= 0 || u.indexOf(".m3u") >= 0) return true;
        if (u.indexOf(".mp4") >= 0) return true;
        if (u.indexOf(".mkv") >= 0) return true;
        if (u.indexOf(".ts") >= 0) return true;
        if (u.indexOf(".webm") >= 0) return true;
        if (u.indexOf("/hls/") >= 0) return true;
        if (u.indexOf("manifest") >= 0 && (u.indexOf(".mpd") >= 0 || u.indexOf(".m3u8") >= 0)) return true;
        // Known working streaming domains (embed-based)
        var embeds = [
            "dood.wf", "dood.so", "doodstream", "d000d.com",
            "mp4upload.com", "embasic.pro", "rapidshare.cc",
            "mixdrop", "streamruby", "embeds.to", "netmirror"
        ];
        for (var i = 0; i < embeds.length; i++) {
            if (u.indexOf(embeds[i]) >= 0) return true;
        }
        return false;
    }

    // =========================================================================
    // PROVIDER DISCOVERY (from manifest URLs)
    // =========================================================================

    function getManifestUrls() {
        if (manifest && manifest.nuvioManifests && Array.isArray(manifest.nuvioManifests)) {
            return manifest.nuvioManifests;
        }
        return FALLBACK_MANIFESTS;
    }

    async function discoverProviders() {
        if (_providers) return _providers;

        var urls = getManifestUrls();
        log("Discovering providers from " + urls.length + " manifests...");

        var all = [];

        await Promise.allSettled(urls.map(async function(manifestUrl) {
            try {
                var m = await fetchJson(manifestUrl);
                if (!m || !m.scrapers) return;

                var baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf("/"));

                m.scrapers.forEach(function(s) {
                    if (s.enabled === false) return;
                    if (!s.filename) return;

                    var fileUrl = s.filename.indexOf("http") === 0 ? s.filename : baseUrl + "/" + s.filename;

                    all.push({
                        id: baseUrl + "/" + (s.id || s.name || s.filename),
                        name: s.name || s.id || s.filename,
                        fileUrl: fileUrl,
                        types: s.supportedTypes || ["movie", "tv"]
                    });
                });
            } catch(e) {
                log("Manifest error: " + (manifestUrl.slice(0, 50) + "...") + " - " + e.message);
            }
        }));

        log("Discovered " + all.length + " providers");
        _providers = all;
        return all;
    }

    // =========================================================================
    // PROVIDER CODE LOADING (with caching and timeout)
    // =========================================================================

    async function loadProvider(id, fileUrl) {
        if (_fnCache[id]) return _fnCache[id];

        try {
            var code = await withTimeout(fetchText(fileUrl), FETCH_CODE_TIMEOUT, "Fetch " + (fileUrl.split("/").pop() || ""));
            if (!code) throw new Error("Empty code");

            code = code.replace(/^["']use strict["'];?\s*/m, "");

            var factory = new Function("return (function(module){" + code + "\nreturn module.exports;})")();
            var mod = { exports: {} };
            var exported = factory(mod);

            if (exported && typeof exported.getStreams === "function") {
                _fnCache[id] = exported.getStreams;
                log("Loaded: " + (fileUrl.split("/").pop() || ""));
                return exported.getStreams;
            }
        } catch(e) {
            // Silent fail for non-critical providers
        }

        _fnCache[id] = null;
        return null;
    }

    async function callProvider(getStreamsFn, tmdbId, mediaType, season, episode, label) {
        try {
            var result = await withTimeout(
                getStreamsFn(tmdbId, mediaType, season, episode),
                PROVIDER_TIMEOUT,
                label
            );
            return Array.isArray(result) ? result : [];
        } catch(e) {
            return [];
        }
    }

    // =========================================================================
    // STREAM FETCHING PIPELINE
    // =========================================================================

    // Sort providers: known good ones first, then by score, then alphabetically
    function sortProviders(providers, mediaType) {
        return providers.slice().sort(function(a, b) {
            var aScore = _providerScore[a.id] || 0;
            var bScore = _providerScore[b.id] || 0;
            if (aScore !== bScore) return bScore - aScore;
            return (a.name || "").localeCompare(b.name || "");
        });
    }

    async function fetchStreams(tmdbId, mediaType, season, episode) {
        var startTime = Date.now();
        var providers = await discoverProviders();
        if (!providers || providers.length === 0) return [];

        // Filter by media type
        var valid = providers.filter(function(pr) {
            var types = pr.types || ["movie", "tv"];
            return types.indexOf(mediaType) >= 0;
        });

        if (valid.length === 0) return [];

        // Sort: best providers first
        valid = sortProviders(valid, mediaType);

        var allStreams = [];

        // Process in parallel batches
        for (var i = 0; i < valid.length && allStreams.length < EARLY_EXIT_STREAMS; i += BATCH_SIZE) {
            var batch = valid.slice(i, i + BATCH_SIZE);

            var batchResults = await Promise.allSettled(batch.map(async function(pr) {
                var getStreamsFn = await loadProvider(pr.id, pr.fileUrl);
                if (!getStreamsFn) return [];

                var nStreams = await callProvider(
                    getStreamsFn, tmdbId, mediaType, season, episode, pr.name
                );
                if (!Array.isArray(nStreams) || nStreams.length === 0) return [];

                // Update score for successful providers
                _providerScore[pr.id] = (_providerScore[pr.id] || 0) + nStreams.length;

                // Filter to only playable URLs, extract quality
                return nStreams.map(function(s) {
                    if (!s || !s.url) return null;
                    if (!isPlayableUrl(s.url)) {
                        if (!s.headers || Object.keys(s.headers).length === 0) return null;
                    }
                    var quality = s.quality || detectQuality(s.url, s.name) || "Auto";
                    return new StreamResult({
                        url: s.url,
                        source: quality,
                        headers: s.headers || {},
                        subtitles: s.subtitles || undefined
                    });
                }).filter(function(s) { return s !== null; });
            }));

            // Collect results
            batchResults.forEach(function(r) {
                if (r.status === "fulfilled" && Array.isArray(r.value)) {
                    allStreams = allStreams.concat(r.value);
                }
            });
        }

        // Deduplicate by URL
        var seen = {};
        var unique = [];
        allStreams.forEach(function(s) {
            if (!s || !s.url) return;
            var key = s.url;
            if (!seen[key]) {
                seen[key] = true;
                unique.push(s);
            }
        });

        var elapsed = (Date.now() - startTime) + "ms";
        log("Scraped " + unique.length + " streams from " + valid.length + " providers in " + elapsed);
        return unique;
    }

    // =========================================================================
    // TMDB → MultimediaItem (for home, search, load)
    // =========================================================================

    function toItem(d, type) {
        var title = type === "tv" ? d.name : d.title;
        var date = type === "tv" ? d.first_air_date : d.release_date;
        var year = date ? parseInt(date.substring(0, 4), 10) : undefined;

        return new MultimediaItem({
            title: title || "Unknown",
            url: makeUrl(d.id, type),
            posterUrl: imgUrl(d.poster_path),
            type: type === "tv" ? "series" : "movie",
            year: year,
            score: d.vote_average || undefined,
            description: d.overview || "",
            bannerUrl: imgUrl(d.backdrop_path, "w1280"),
            cast: [],
            trailers: []
        });
    }

    // =========================================================================
    // PLUGIN FUNCTIONS
    // =========================================================================

    // ----- getHome (dynamic: 10+ categories) -----
    async function getHome(cb) {
        try {
            // Fetch all categories in parallel
            var results = await Promise.allSettled([
                tmdbFetch("/trending/movie/week").then(function(r) { return { key: "Trending Movies", data: r }; }),
                tmdbFetch("/trending/tv/week").then(function(r) { return { key: "Trending TV Shows", data: r }; }),
                tmdbFetch("/movie/popular").then(function(r) { return { key: "Popular Movies", data: r }; }),
                tmdbFetch("/tv/popular").then(function(r) { return { key: "Popular TV Shows", data: r }; }),
                tmdbFetch("/movie/top_rated").then(function(r) { return { key: "Top Rated Movies", data: r }; }),
                tmdbFetch("/tv/top_rated").then(function(r) { return { key: "Top Rated TV Shows", data: r }; }),
                tmdbFetch("/movie/now_playing").then(function(r) { return { key: "Now Playing", data: r }; }),
                tmdbFetch("/tv/airing_today").then(function(r) { return { key: "Airing Today", data: r }; }),
                tmdbFetch("/movie/upcoming").then(function(r) { return { key: "Upcoming", data: r }; }),
                tmdbFetch("/trending/all/week").then(function(r) { return { key: "Trending Now", data: r }; })
            ]);

            var data = {};

            results.forEach(function(result) {
                if (result.status !== "fulfilled" || !result.value) return;
                var r = result.value;
                if (!r.data || !r.data.results) return;

                var items = r.data.results.slice(0, MAX_HOME_ITEMS).map(function(item) {
                    var t = item.media_type || (r.key.indexOf("TV") >= 0 || r.key.indexOf("Airing") >= 0 || r.key.indexOf("Shows") >= 0 ? "tv" : "movie");
                    // For trending/all, detect type from item
                    if (r.key === "Trending Now") {
                        t = item.media_type === "tv" ? "tv" : "movie";
                    }
                    return toItem(item, t);
                });

                if (items.length > 0) {
                    data[r.key] = items;
                }
            });

            cb({ success: true, data: data });
        } catch(e) {
            log("getHome error: " + e.message);
            cb({ success: false, errorCode: "INTERNAL_ERROR", message: e.message });
        }
    }

    // ----- search -----
    async function search(query, cb) {
        try {
            var [movies, tv] = await Promise.all([
                tmdbFetch("/search/movie?query=" + encodeURIComponent(query)),
                tmdbFetch("/search/tv?query=" + encodeURIComponent(query))
            ]);

            var results = [];
            if (movies && movies.results) {
                movies.results.slice(0, 10).forEach(function(m) { results.push(toItem(m, "movie")); });
            }
            if (tv && tv.results) {
                tv.results.slice(0, 10).forEach(function(t) { results.push(toItem(t, "tv")); });
            }

            cb({ success: true, data: results });
        } catch(e) {
            log("search error: " + e.message);
            cb({ success: false, errorCode: "INTERNAL_ERROR", message: e.message });
        }
    }

    // ----- load -----
    async function load(url, cb) {
        try {
            var p = parseUrl(url);
            if (!p) return cb({ success: false, errorCode: "BAD_REQUEST", message: "Invalid URL" });

            if (p.mediaType === "movie") {
                var d = await tmdbFetch("/movie/" + p.tmdbId);
                if (!d) return cb({ success: false, errorCode: "NOT_FOUND" });
                cb({ success: true, data: toItem(d, "movie") });
            } else if (p.mediaType === "tv") {
                var [tvData, s1, s2, s3, s4, s5] = await Promise.all([
                    tmdbFetch("/tv/" + p.tmdbId),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/1"),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/2"),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/3"),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/4"),
                    tmdbFetch("/tv/" + p.tmdbId + "/season/5")
                ]);
                if (!tvData) return cb({ success: false, errorCode: "NOT_FOUND" });

                var item = toItem(tvData, "tv");
                var episodes = [];
                var seasons = [s1, s2, s3, s4, s5];

                seasons.forEach(function(sd) {
                    if (!sd || !sd.episodes) return;
                    sd.episodes.forEach(function(ep) {
                        episodes.push(new Episode({
                            name: "S" + String(sd.season_number).padStart(2, "0") + "E" + String(ep.episode_number).padStart(2, "0") + " - " + (ep.name || ""),
                            url: makeUrl(p.tmdbId, "tv", sd.season_number, ep.episode_number),
                            season: sd.season_number,
                            episode: ep.episode_number,
                            rating: ep.vote_average,
                            runtime: ep.runtime,
                            airDate: ep.air_date || ""
                        }));
                    });
                });

                item.episodes = episodes;
                log("load: " + episodes.length + " episodes");
                cb({ success: true, data: item });
            } else {
                cb({ success: false, errorCode: "BAD_REQUEST", message: "Unknown type: " + p.mediaType });
            }
        } catch(e) {
            log("load error: " + e.message);
            cb({ success: false, errorCode: "INTERNAL_ERROR", message: e.message });
        }
    }

    // ----- loadStreams (cached + massively parallel) -----
    async function loadStreams(url, cb) {
        try {
            var p = parseUrl(url);
            if (!p) return cb({ success: false, errorCode: "BAD_REQUEST" });

            var streamKey = cacheKey(url);
            log("Streams: " + streamKey);

            // Memory cache — instant return for repeat taps
            var cached = _streamCache[streamKey];
            if (cached) {
                log("Cache hit: " + cached.length + " streams");
                return cb({ success: true, data: cached });
            }

            // Fetch streams (fast parallel pipeline)
            var allStreams = await fetchStreams(p.tmdbId, p.mediaType, p.season, p.episode);

            // Cache for instant repeat lookups
            _streamCache[streamKey] = allStreams;

            log("Found " + allStreams.length + " streams");
            cb({ success: true, data: allStreams });
        } catch(e) {
            log("loadStreams error: " + e.message);
            cb({ success: true, data: [] });
        }
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

    log("Plugin loaded v3");
})();
