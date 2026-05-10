/**
 * MultiSource Plugin for SkyStream
 *
 * Self-contained: no external API server needed.
 *   getHome / search / load  → Stremio TMDB Addon
 *   loadStreams              → Directly scrapes 14 sources via http_get/http_post
 *
 * URL scheme:
 *   Items:     tmdb:movie:24428  or  tmdb:series:1396
 *   Episodes:  tmdb:movie:24428  or  tmdb:tv:1396:1:1
 */

(function () {
    "use strict";

    const TMDB_ADDON = manifest.baseUrl || "https://94c8cb9f702d-tmdb-addon.baby-beamup.club";
    const SOURCE_TIMEOUT = 25000;
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    // ── Helpers ────────────────────────────────────────────────────────────

    function extractTmdbId(id) {
        var m = String(id).match(/tmdb:(\d+)/);
        return m ? m[1] : id;
    }

    function fetchJson(url, headers) {
        var h = Object.assign({ "User-Agent": UA, "Accept": "application/json" }, headers || {});
        return http_get(url, h).then(function (r) {
            if (r.status !== 200 || !r.body) return null;
            try { return JSON.parse(r.body); } catch (e) { return null; }
        });
    }

    function fetchText(url, headers) {
        var h = Object.assign({ "User-Agent": UA }, headers || {});
        return http_get(url, h).then(function (r) {
            return r.status === 200 && r.body ? r.body : null;
        });
    }

    function resolveUrl(base, relative) {
        if (!relative) return "";
        if (relative.indexOf("http://") === 0 || relative.indexOf("https://") === 0) return relative;
        var b = base.replace(/\/+$/, "");
        var r = relative.indexOf("/") === 0 ? relative : "/" + relative;
        var match = b.match(/^(https?:\/\/[^\/]+)/);
        return match ? match[1] + r : b + r;
    }

    // Parse m3u8 master playlist into quality variants
    function parseMasterM3u8(m3u8, baseUrl) {
        var streams = [];
        var lines = m3u8.split("\n");
        var qMap = { "360": "360p", "480": "480p", "720": "720p", "1080": "1080p", "2160": "4K" };
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].indexOf("#EXT-X-STREAM-INF:") !== 0) continue;
            var bw = lines[i].match(/BANDWIDTH=(\d+)/);
            var res = lines[i].match(/RESOLUTION=(\d+x\d+)/);
            var nl = lines[i + 1] ? lines[i + 1].trim() : "";
            if (nl && nl.indexOf("#") !== 0) {
                var vu = resolveUrl(baseUrl, nl);
                var h = res ? res[1].split("x")[1] : "";
                streams.push({
                    url: vu,
                    type: "hls",
                    quality: qMap[h] || (h ? h + "p" : ""),
                    resolution: res ? res[1] : "",
                    bandwidth: bw ? parseInt(bw[1]) : undefined
                });
                i++;
            }
        }
        if (streams.length === 0) {
            // Single quality or media playlist
            var urls = lines.filter(function (l) {
                l = l.trim();
                return l && l.indexOf("#") !== 0 && (l.indexOf("http://") === 0 || l.indexOf("https://") === 0);
            });
            urls.forEach(function (u) { streams.push({ url: u, type: "hls", quality: "", resolution: "" }); });
        }
        return streams;
    }

    // ── Source Scrapers ────────────────────────────────────────────────────
    // Each returns: { source, status, streams[], subtitles[], latency_ms }

    // 1. vaplayer.ru — JSON API → HLS master playlist
    function scrapeVaplayer(tmdbId, type, season, episode) {
        var start = Date.now();
        var apiUrl = "https://streamdata.vaplayer.ru/api.php?tmdb=" + tmdbId + "&type=" + type;
        if (type === "tv") apiUrl += "&season=" + (season || 1) + "&episode=" + (episode || 1);

        return fetchJson(apiUrl, {
            "Referer": "https://brightpathsignals.com/embed/" + type + "/" + tmdbId,
        }).then(function (data) {
            if (!data || data.status_code !== "200" || !data.data || !data.data.stream_urls || data.data.stream_urls.length === 0) {
                return { source: "vaplayer.ru", status: "no_streams", streams: [], latency_ms: Date.now() - start };
            }
            // Fetch each m3u8 parallel
            var promises = (data.data.stream_urls || []).map(function (url) {
                return fetchText(url, { "Referer": "https://brightpathsignals.com/" }).then(function (m3u8Body) {
                    if (!m3u8Body) return [];
                    return parseMasterM3u8(m3u8Body, url);
                }).catch(function () { return []; });
            });
            return Promise.all(promises).then(function (results) {
                var streams = [];
                results.forEach(function (arr) { arr.forEach(function (s) { streams.push(s); }); });
                // Deduplicate
                var seen = {};
                streams = streams.filter(function (s) {
                    if (seen[s.url]) return false;
                    seen[s.url] = true;
                    return true;
                });
                return {
                    source: "vaplayer.ru",
                    status: streams.length > 0 ? "working" : "no_streams",
                    streams: streams,
                    latency_ms: Date.now() - start,
                };
            });
        }).catch(function (err) {
            return { source: "vaplayer.ru", status: "error", error: err.message, streams: [], latency_ms: Date.now() - start };
        });
    }

    // 2. ezvidapi.com — Proxied API → HLS + subtitles
    function scrapeEzvidapi(tmdbId, type, season, episode) {
        var start = Date.now();
        var providers = ["vidrock", "vidzee"];

        function tryProvider(idx) {
            if (idx >= providers.length) {
                return { source: "ezvidapi.com", status: "embed", streams: [], latency_ms: Date.now() - start };
            }
            var provider = providers[idx];
            var apiUrl = type === "movie"
                ? "https://api.ezvidapi.com/movie/" + provider + "/" + tmdbId
                : "https://api.ezvidapi.com/tv/" + provider + "/" + tmdbId + "?season=" + (season || 1) + "&episode=" + (episode || 1);

            return fetchJson(apiUrl, { "Referer": "https://api.ezvidapi.com" }).then(function (data) {
                if (!data || !data.stream_url) return tryProvider(idx + 1);

                // Fetch m3u8
                return fetchText(data.stream_url, { "Referer": "https://api.ezvidapi.com" }).then(function (m3u8Body) {
                    var streams = [];
                    if (m3u8Body && m3u8Body.indexOf("#EXTM3U") === 0) {
                        streams = parseMasterM3u8(m3u8Body, data.stream_url);
                    }
                    // Subtitles
                    var subtitles = undefined;
                    if (Array.isArray(data.subtitles) && data.subtitles.length > 0) {
                        subtitles = data.subtitles.map(function (s) {
                            return { url: s.url || s.u, lang: s.label || s.l || s.language || "unknown", type: "vtt" };
                        });
                    }
                    return {
                        source: "ezvidapi.com (" + provider + ")",
                        status: streams.length > 0 ? "working" : "no_streams",
                        streams: streams,
                        subtitles: subtitles,
                        latency_ms: Date.now() - start,
                    };
                }).catch(function () { return tryProvider(idx + 1); });
            }).catch(function () { return tryProvider(idx + 1); });
        }

        return tryProvider(0);
    }

    // 3. vidlink.pro — enc-dec.app → vidlink.pro API → HLS + captions
    function scrapeVidlink(tmdbId, type, season, episode) {
        var start = Date.now();

        // Step 1: Encrypt TMDB ID
        return fetchJson("https://enc-dec.app/api/enc-vidlink?text=" + tmdbId).then(function (encData) {
            if (!encData || encData.status !== 200 || !encData.result) {
                return { source: "vidlink.pro", status: "error", error: "Encryption failed", streams: [], latency_ms: Date.now() - start };
            }
            var encId = encData.result;

            // Step 2: Get stream data from vidlink
            var apiUrl = type === "movie"
                ? "https://vidlink.pro/api/b/movie/" + encId + "?multiLang=0"
                : "https://vidlink.pro/api/b/tv/" + encId + "/" + (season || 1) + "/" + (episode || 1) + "?multiLang=0";

            return fetchJson(apiUrl, {
                "Referer": "https://vidlink.pro/",
                "User-Agent": UA,
            }).then(function (streamData) {
                if (!streamData || !streamData.stream || !streamData.stream.playlist) {
                    return { source: "vidlink.pro", status: "no_streams", streams: [], latency_ms: Date.now() - start };
                }

                var playlistUrl = streamData.stream.playlist;
                var captions = (streamData.stream.captions || []).map(function (c) {
                    return { url: c.url || c.id || "", lang: c.language || c.label || "unknown", type: "vtt" };
                }).filter(function (c) { return c.url; });

                // Step 3: Fetch master playlist
                return fetchText(playlistUrl, { "Referer": "https://vidlink.pro/" }).then(function (m3u8Body) {
                    var streams = [];
                    if (m3u8Body && m3u8Body.indexOf("#EXTM3U") === 0) {
                        streams = parseMasterM3u8(m3u8Body, playlistUrl);
                    }
                    if (streams.length === 0) {
                        streams.push({ url: playlistUrl, type: "hls", quality: "", resolution: "" });
                    }
                    return {
                        source: "vidlink.pro",
                        status: streams.length > 0 ? "working" : "no_streams",
                        streams: streams,
                        subtitles: captions.length > 0 ? captions : undefined,
                        latency_ms: Date.now() - start,
                    };
                }).catch(function () {
                    return { source: "vidlink.pro", status: "embed", streams: [{ url: playlistUrl, type: "hls" }], latency_ms: Date.now() - start };
                });
            });
        }).catch(function (err) {
            return { source: "vidlink.pro", status: "error", error: err.message, streams: [], latency_ms: Date.now() - start };
        });
    }

    // 4. videasy.net — API → enc-dec.app → HLS + subtitles
    function scrapeVideasy(tmdbId, type, season, episode) {
        var start = Date.now();

        // Step 1: Get encrypted data from videasy API
        var params = "title=&mediaType=" + type + "&year=&tmdbId=" + tmdbId + (type === "tv" ? "&season=" + (season || 1) + "&episode=" + (episode || 1) : "");
        var apiUrl = "https://api.videasy.net/cdn/sources-with-title?" + params;

        return fetchText(apiUrl, { "Referer": "https://videasy.net/" }).then(function (encryptedText) {
            if (!encryptedText || encryptedText.length < 10) {
                return { source: "videasy.net", status: "no_streams", streams: [], latency_ms: Date.now() - start };
            }

            // Step 2: Decrypt via enc-dec.app
            return http_post("https://enc-dec.app/api/dec-videasy",
                { "Content-Type": "application/json", "User-Agent": UA },
                JSON.stringify({ text: encryptedText, id: String(tmdbId) })
            ).then(function (resp) {
                if (resp.status !== 200 || !resp.body) {
                    return { source: "videasy.net", status: "error", error: "Decryption failed", streams: [], latency_ms: Date.now() - start };
                }
                var decryptData;
                try { decryptData = JSON.parse(resp.body); } catch (e) { return { source: "videasy.net", status: "error", error: "Decrypt parse failed", streams: [], latency_ms: Date.now() - start }; }

                if (decryptData.status !== 200 || !decryptData.result) {
                    return { source: "videasy.net", status: "error", error: "Decryption returned error", streams: [], latency_ms: Date.now() - start };
                }

                var result = decryptData.result;
                var rawSources = result.sources || [];
                var rawSubtitles = result.subtitles || [];

                var streams = rawSources.map(function (s) {
                    var qMap = { "4K": "3840x2160", "2160p": "3840x2160", "1080p": "1920x1080", "720p": "1280x720", "480p": "854x480", "360p": "640x360" };
                    return { url: s.url, type: "hls", quality: s.quality || "", resolution: qMap[s.quality] || "" };
                });

                var subtitles = rawSubtitles.map(function (s) {
                    return { url: s.url, lang: s.language || s.lang || "unknown", type: "vtt" };
                });

                return {
                    source: "videasy.net",
                    status: streams.length > 0 ? "working" : "no_streams",
                    streams: streams,
                    subtitles: subtitles.length > 0 ? subtitles : undefined,
                    latency_ms: Date.now() - start,
                };
            });
        }).catch(function (err) {
            return { source: "videasy.net", status: "error", error: err.message, streams: [], latency_ms: Date.now() - start };
        });
    }

    // 5. vixsrc.to — API → embed page → stream URLs
    function scrapeVixsrc(tmdbId, type, season, episode) {
        var start = Date.now();
        var apiUrl = type === "movie"
            ? "https://vixsrc.to/api/movie/" + tmdbId
            : "https://vixsrc.to/api/tv/" + tmdbId + "/" + (season || 1) + "/" + (episode || 1);

        return fetchJson(apiUrl, { "Referer": "https://vixsrc.to/" }).then(function (apiData) {
            if (!apiData || !apiData.src) {
                return { source: "vixsrc.to", status: "no_streams", streams: [], latency_ms: Date.now() - start };
            }
            var embedUrl = "https://vixsrc.to" + apiData.src;
            return fetchText(embedUrl, { "Referer": "https://vixsrc.to/" }).then(function (html) {
                if (!html) return { source: "vixsrc.to", status: "embed", streams: [], latency_ms: Date.now() - start };

                var streams = [];
                var seen = {};

                // Extract window.streams URLs
                var streamMatches = html.match(/url:\s*'([^']+)'/g) || [];
                streamMatches.forEach(function (m) {
                    var url = m.match(/'([^']+)'/);
                    if (url && url[1].indexOf("/playlist/") !== -1 && !seen[url[1]]) {
                        seen[url[1]] = true;
                        streams.push({ url: url[1], type: "hls", quality: "", resolution: "" });
                    }
                });

                // Try to get auth'd playlist
                var token = html.match(/'token':\s*'([^']+)'/);
                var expires = html.match(/'expires':\s*'([^']+)'/);
                var plMatch = html.match(/url:\s*'([^']+)'/);
                var playlistUrl = plMatch ? plMatch[1] : null;

                if (playlistUrl && token && expires && !seen[playlistUrl]) {
                    var authedUrl = playlistUrl + "?token=" + token[1] + "&expires=" + expires[1];
                    seen[playlistUrl] = true;
                    // Try fetching (may 403)
                    streams.push({ url: authedUrl, type: "hls", quality: "", resolution: "" });
                }

                return {
                    source: "vixsrc.to",
                    embedUrl: embedUrl,
                    status: streams.length > 0 ? "working" : "embed",
                    streams: streams,
                    latency_ms: Date.now() - start,
                };
            });
        }).catch(function (err) {
            return { source: "vixsrc.to", status: "error", error: err.message, streams: [], latency_ms: Date.now() - start };
        });
    }

    // 6-14. Embed/blocked sources — return embed status
    function scrapeCinesrc(tmdbId, type, season, episode) {
        return Promise.resolve({ source: "cinesrc.st", status: "embed", streams: [], latency_ms: 0 });
    }
    function scrapeCloudnestra(tmdbId, type, season, episode) {
        return Promise.resolve({ source: "cloudnestra.com", status: "embed", error: "Cloudflare Turnstile", streams: [], latency_ms: 0 });
    }
    function scrapeVidsrcEmbed(tmdbId, type, season, episode) {
        return Promise.resolve({ source: "vidsrc-embed.su", status: "embed", error: "Cloudflare Turnstile", streams: [], latency_ms: 0 });
    }
    function scrapeVidsrcFyi(tmdbId, type, season, episode) {
        return Promise.resolve({ source: "vidsrc.fyi", status: "embed", error: "Cloudflare Turnstile", streams: [], latency_ms: 0 });
    }
    function scrapeVidsrcIcu(tmdbId, type, season, episode) {
        return Promise.resolve({ source: "vidsrc.icu", status: "embed", error: "Cloudflare Turnstile", streams: [], latency_ms: 0 });
    }
    function scrapeVidsrcTo(tmdbId, type, season, episode) {
        return Promise.resolve({ source: "vidsrc.to", status: "embed", error: "Cloudflare Turnstile", streams: [], latency_ms: 0 });
    }
    function scrapeVidsrcme(tmdbId, type, season, episode) {
        return Promise.resolve({ source: "vidsrcme.su", status: "embed", error: "Cloudflare Turnstile", streams: [], latency_ms: 0 });
    }
    function scrapeVsrc(tmdbId, type, season, episode) {
        return Promise.resolve({ source: "vsrc.su", status: "embed", error: "Cloudflare Turnstile", streams: [], latency_ms: 0 });
    }
    function scrapeVidapi(tmdbId, type, season, episode) {
        return Promise.resolve({ source: "vidapi.xyz", status: "embed", error: "React app, needs browser", streams: [], latency_ms: 0 });
    }

    // All sources
    var ALL_SOURCES = [
        scrapeVaplayer,
        scrapeEzvidapi,
        scrapeVidlink,
        scrapeVideasy,
        scrapeVixsrc,
        scrapeCinesrc,
        scrapeCloudnestra,
        scrapeVidsrcEmbed,
        scrapeVidsrcFyi,
        scrapeVidsrcIcu,
        scrapeVidsrcTo,
        scrapeVidsrcme,
        scrapeVsrc,
        scrapeVidapi,
    ];

    // ── Aggregate all sources for streams ─────────────────────────────────

    function aggregateStreams(tmdbId, type, season, episode) {
        var start = Date.now();
        var promises = ALL_SOURCES.map(function (fn) {
            return fn(tmdbId, type, season, episode);
        });

        return Promise.all(promises).then(function (results) {
            var allStreams = [];
            var workingCount = 0;

            results.forEach(function (r) {
                if (r.status === "working" && r.streams && r.streams.length > 0) workingCount++;
                (r.streams || []).forEach(function (s) { allStreams.push(s); });
            });

            // Deduplicate by URL
            var seen = {};
            allStreams = allStreams.filter(function (s) {
                if (seen[s.url]) return false;
                seen[s.url] = true;
                return true;
            });

            return {
                success: true,
                tmdbId: tmdbId,
                type: type,
                workingSources: workingCount,
                totalSourcesChecked: ALL_SOURCES.length,
                totalUniqueStreams: allStreams.length,
                elapsed_ms: Date.now() - start,
                sources: results,
                streams: allStreams,
            };
        });
    }

    // ── TMDB Addon Helpers ────────────────────────────────────────────────

    var CATALOGS = [
        { id: "tmdb.top",        type: "movie",  name: "Popular Movies" },
        { id: "tmdb.top",        type: "series", name: "Popular Series" },
        { id: "tmdb.trending",   type: "movie",  name: "Trending Movies" },
        { id: "tmdb.trending",   type: "series", name: "Trending Series" },
        { id: "tmdb.latest",     type: "movie",  name: "Latest Movies" },
        { id: "tmdb.latest",     type: "series", name: "Latest Series" },
    ];

    function metaToItem(meta) {
        var isSeries = meta.type === "series";
        return {
            title: meta.name || meta.title || "Unknown",
            url: "tmdb:" + (isSeries ? "series" : "movie") + ":" + extractTmdbId(meta.id),
            posterUrl: meta.poster || meta.posterUrl || "",
            type: isSeries ? "series" : "movie",
            description: meta.description || meta.plot || "",
            tags: meta.genres || [],
            year: meta.year || meta.releaseInfo || "",
        };
    }

    // ── getHome ───────────────────────────────────────────────────────────

    function getHome(cb, page) {
        var data = {};
        var pageNum = parseInt(page) || 1;
        var skip = (pageNum - 1) * 20;

        var promises = CATALOGS.map(function (cat) {
            var url = TMDB_ADDON + "/catalog/" + cat.type + "/" + cat.id + ".json";
            if (skip > 0) url += (url.indexOf("?") === -1 ? "?" : "&") + "skip=" + skip;

            return fetchJson(url).then(function (json) {
                if (!json || !json.metas || json.metas.length === 0) return;
                var items = json.metas.map(function (m) { return new MultimediaItem(metaToItem(m)); });
                if (items.length > 0) data[cat.name] = items;
            }).catch(function () {});
        });

        Promise.all(promises).then(function () {
            cb({ success: true, data: data });
        }).catch(function (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        });
    }

    // ── search ────────────────────────────────────────────────────────────

    function search(query, cb) {
        if (!query || typeof query !== "string" || query.trim().length === 0) {
            return cb({ success: true, data: [] });
        }

        var q = encodeURIComponent(query.trim());
        var allItems = [];
        var types = ["movie", "series"];

        var promises = types.map(function (type) {
            var url = TMDB_ADDON + "/catalog/" + type + "/tmdb.search.json?search=" + q;
            return fetchJson(url).then(function (json) {
                if (json && json.metas) {
                    json.metas.forEach(function (m) { allItems.push(new MultimediaItem(metaToItem(m))); });
                }
            }).catch(function () {});
        });

        Promise.all(promises).then(function () {
            cb({ success: true, data: allItems });
        }).catch(function (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        });
    }

    // ── load ──────────────────────────────────────────────────────────────

    function load(url, cb) {
        if (!url || typeof url !== "string") {
            return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid URL" });
        }

        var parts = url.split(":");
        if (parts.length < 3 || parts[0] !== "tmdb") {
            return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid URL format: " + url });
        }

        var type = parts[1]; // "movie" or "series"
        var tmdbId = parts.slice(2).join(":");
        var addonType = type === "series" ? "series" : "movie";
        var metaUrl = TMDB_ADDON + "/meta/" + addonType + "/tmdb:" + tmdbId + ".json";

        fetchJson(metaUrl).then(function (json) {
            if (!json || !json.meta) {
                return cb({ success: false, errorCode: "NETWORK_ERROR", message: "Meta not found from TMDB addon" });
            }

            var meta = json.meta;
            var title = meta.name || meta.title || "Unknown";
            var poster = meta.poster || meta.posterUrl || "";
            var background = meta.background || "";
            var description = meta.description || meta.plot || "";
            var genres = meta.genres || [];
            var year = meta.year || meta.releaseInfo || "";
            var imdbRating = meta.imdbRating ? String(meta.imdbRating) : "";

            var episodes = [];

            if (type === "series") {
                var videos = meta.videos || [];
                var sorted = videos
                    .filter(function (v) { return v.season > 0; })
                    .sort(function (a, b) { return (a.season - b.season) || (a.episode - b.episode); });

                sorted.forEach(function (v) {
                    var epTitle = v.title || ("Episode " + v.episode);
                    var epPoster = v.thumbnail || poster;
                    episodes.push(new Episode({
                        name: "S" + v.season + "E" + v.episode + " - " + epTitle,
                        url: "tmdb:tv:" + tmdbId + ":" + v.season + ":" + v.episode,
                        season: v.season,
                        episode: v.episode,
                        posterUrl: epPoster,
                    }));
                });

                if (episodes.length === 0) {
                    episodes.push(new Episode({
                        name: title,
                        url: "tmdb:tv:" + tmdbId + ":1:1",
                        season: 1, episode: 1,
                        posterUrl: poster,
                    }));
                }
            } else {
                episodes.push(new Episode({
                    name: title,
                    url: "tmdb:movie:" + tmdbId,
                    season: 1, episode: 1,
                    posterUrl: poster,
                }));
            }

            var item = new MultimediaItem({
                title: title,
                url: url,
                posterUrl: poster,
                backgroundUrl: background,
                type: type === "series" ? "series" : "movie",
                description: description,
                tags: genres,
                year: year,
                imdbRating: imdbRating,
                episodes: episodes,
            });

            cb({ success: true, data: item });
        }).catch(function (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        });
    }

    // ── loadStreams ───────────────────────────────────────────────────────

    function loadStreams(url, cb) {
        if (!url || typeof url !== "string") {
            return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid URL" });
        }

        var parts = url.split(":");
        if (parts.length < 2 || parts[0] !== "tmdb") {
            return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid URL format: " + url });
        }

        var tmdbId, type, season, episode;

        if (parts[1] === "tv" && parts.length >= 5) {
            // tmdb:tv:1396:1:1
            type = "tv";
            tmdbId = parts[2];
            season = parseInt(parts[3]) || 1;
            episode = parseInt(parts[4]) || 1;
        } else if (parts[1] === "movie") {
            // tmdb:movie:24428
            type = "movie";
            tmdbId = parts[2];
            season = 1;
            episode = 1;
        } else {
            return cb({ success: false, errorCode: "PARSE_ERROR", message: "Unknown type: " + parts[1] });
        }

        aggregateStreams(tmdbId, type, season, episode).then(function (result) {
            var streams = [];
            var seen = {};

            result.sources.forEach(function (source) {
                if (source.status !== "working" || !source.streams) return;
                source.streams.forEach(function (s) {
                    if (!s.url || seen[s.url]) return;
                    seen[s.url] = true;
                    streams.push(new StreamResult({
                        url: s.url,
                        source: source.source + (s.quality ? " [" + s.quality + "]" : ""),
                        headers: {
                            "Referer": source.embedUrl || (type === "movie"
                                ? "https://brightpathsignals.com/embed/movie/" + tmdbId
                                : "https://brightpathsignals.com/embed/tv/" + tmdbId),
                            "User-Agent": UA,
                        },
                    }));
                });
            });

            cb({ success: true, data: streams });
        }).catch(function (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message });
        });
    }

    // ── Exports ───────────────────────────────────────────────────────────

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
