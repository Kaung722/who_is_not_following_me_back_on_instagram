import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unzipSync } from 'fflate';
import {
  Upload,
  Users,
  UserX,
  Trash2,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Check,
  ChevronDown,
  Shield,
} from 'lucide-react';

const STORAGE_KEY = 'ig-unfollowers-data';
const STORAGE_VERSION = 4;
const IGNORED_EXPORT_NAME =
  /pending_follow|recent_follow|recently_unfollowed|blocked_profiles|close_friends|hide_story|favorited|removed_suggestions|restricted_profiles|follow_requests_you.?ve_received/i;

const usernameFromHref = (href) => {
  if (!href) return null;
  const cleaned = href.split('?')[0].replace(/\/$/, '');
  const match = cleaned.match(/instagram\.com\/(?:_u\/)?([^/]+)/i);
  return match?.[1] || null;
};

/** Instagram export username precedence: value -> title -> href */
const extractUsername = (entry) => {
  if (!entry) return null;
  const fromList = entry.string_list_data?.[0]?.value;
  if (fromList?.trim()) return fromList.trim();
  if (entry.title?.trim()) return entry.title.trim();
  return usernameFromHref(entry.string_list_data?.[0]?.href);
};

/** Only trust instagram.com http(s) links from the export; anything else is rebuilt from the username. */
const extractHref = (entry) => {
  const href = entry?.string_list_data?.[0]?.href;
  if (!href) return null;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
  return href.includes('/_u/') ? href.replace('/_u/', '/') : href;
};

const toAccount = (entry) => {
  const username = extractUsername(entry);
  if (!username) return null;
  return {
    username,
    href: extractHref(entry) || `https://www.instagram.com/${username}`,
    timestamp: entry.string_list_data?.[0]?.timestamp ?? null,
  };
};

const getRelationshipList = (data, wrapperKey) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[wrapperKey])) return data[wrapperKey];
  return [];
};

const accountKey = (username) => username.trim().toLowerCase();

/** Exports can repeat a handle (and differ only in casing); keep the first occurrence. */
const dedupeAccounts = (accounts) => {
  const byUsername = new Map();
  for (const account of accounts) {
    const key = accountKey(account.username);
    if (!byUsername.has(key)) byUsername.set(key, account);
  }
  return Array.from(byUsername.values());
};

const parseFollowers = (data) =>
  dedupeAccounts(getRelationshipList(data, 'relationships_followers').map(toAccount).filter(Boolean));

const parseFollowing = (data) =>
  dedupeAccounts(getRelationshipList(data, 'relationships_following').map(toAccount).filter(Boolean));

const mergeFollowerAccounts = (parts) =>
  dedupeAccounts(parts.flatMap((part) => parseFollowers(part.raw)));

const sortFollowerPartNames = (names) =>
  [...names].sort((a, b) => {
    const numA = Number(a.match(/followers[_-]?(\d+)/i)?.[1] || 0);
    const numB = Number(b.match(/followers[_-]?(\d+)/i)?.[1] || 0);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b);
  });

const looksLikeFollowerEntry = (entry) =>
  Boolean(
    entry &&
      !entry.label_values &&
      entry.string_list_data?.[0] &&
      (entry.string_list_data[0].value || entry.string_list_data[0].href || entry.title)
  );

const looksLikeFollowingEntry = (entry) =>
  Boolean(entry && !entry.label_values && (entry.title || looksLikeFollowerEntry(entry)));

const isFollowingData = (json) => {
  if (Array.isArray(json?.relationships_following)) {
    return json.relationships_following.some(looksLikeFollowingEntry);
  }
  return false;
};

const isFollowersData = (json) => {
  if (Array.isArray(json?.relationships_followers)) {
    return json.relationships_followers.some(looksLikeFollowerEntry);
  }
  if (Array.isArray(json) && json.length > 0) {
    // Reject other Instagram exports that use label_values (requests, restricted, etc.).
    if (json.some((entry) => entry?.label_values)) return false;
    return json.some(looksLikeFollowerEntry);
  }
  return false;
};

const isFollowersFileName = (fileName) => {
  const name = fileName.toLowerCase();
  if (name.includes('following')) return false;
  return /^followers([_-]?\d+)?\.json$/.test(name) || name.startsWith('followers');
};

const isFollowingFileName = (fileName) => {
  const name = fileName.toLowerCase();
  return name === 'following.json' || /^following([_-]?\d+)?\.json$/.test(name);
};

const detectKind = (fileName, json) => {
  const name = fileName.toLowerCase();

  if (IGNORED_EXPORT_NAME.test(name)) return 'ignored';

  const nameFollowing = isFollowingFileName(name) || (name.includes('following') && !name.includes('follower'));
  const nameFollowers = isFollowersFileName(name);

  if (nameFollowing && isFollowingData(json)) return 'following';
  if (nameFollowers && isFollowersData(json)) return 'followers';
  // Content-only fallback for renamed but valid exports
  if (!nameFollowing && !nameFollowers) {
    if (isFollowingData(json)) return 'following';
    if (isFollowersData(json)) return 'followers';
  }
  if (nameFollowing || nameFollowers) return 'mismatch';
  return null;
};

const readFileAsText = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name || 'file'}.`));
    reader.readAsText(file);
  });

const readFileAsBytes = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error(`Failed to read ${file.name || 'file'}.`));
    reader.readAsArrayBuffer(file);
  });

const basename = (path) => {
  const parts = String(path || '').split(/[/\\]/);
  return parts[parts.length - 1] || path || 'upload.json';
};

const isZipFile = (file) => {
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return name.endsWith('.zip') || type.includes('zip');
};

/** Only following / followers* relationship JSON — ignore the rest of an Instagram export tree. */
const isRelationshipJsonName = (pathOrName) => {
  const name = basename(pathOrName).toLowerCase();
  if (!name.endsWith('.json')) return false;
  if (IGNORED_EXPORT_NAME.test(name)) return false;
  return name.includes('follower') || name.includes('following');
};

const displayNameForFile = (file) =>
  basename(file.webkitRelativePath || file.name) || 'upload.json';

/** Recursively collect File objects from a dropped folder (or flat file list). */
const collectDroppedFiles = async (dataTransfer) => {
  const items = dataTransfer?.items;
  if (!items?.length) return Array.from(dataTransfer?.files || []);

  const files = [];

  const readEntry = async (entry) => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () =>
        new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      // readEntries may return in batches until empty
      let batch = await readBatch();
      while (batch.length) {
        await Promise.all(batch.map(readEntry));
        batch = await readBatch();
      }
    }
  };

  const topEntries = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const entry = item.webkitGetAsEntry?.() || item.getAsEntry?.();
    if (entry) topEntries.push(entry);
    else if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }

  if (topEntries.length) {
    await Promise.all(topEntries.map(readEntry));
    return files;
  }

  return Array.from(dataTransfer.files || []);
};

/** Turn selected Files / folders / ZIPs into { name, json } payloads. iOS MIME types are unreliable. */
const expandSelectedFiles = async (files) => {
  const entries = [];
  const notices = [];

  for (const file of files) {
    if (isZipFile(file)) {
      try {
        const bytes = await readFileAsBytes(file);
        const unzipped = unzipSync(bytes, {
          // Only decompress relationship JSON — full Instagram ZIPs also contain media.
          filter: (entry) => isRelationshipJsonName(entry.name),
        });
        let found = 0;
        for (const [path, data] of Object.entries(unzipped)) {
          const name = basename(path);
          try {
            const text = new TextDecoder().decode(data);
            entries.push({ name, json: JSON.parse(text) });
            found += 1;
          } catch {
            // skip corrupt entries
          }
        }
        if (found) {
          notices.push(`Extracted ${found} JSON file${found > 1 ? 's' : ''} from ${file.name}.`);
        } else {
          notices.push(`No following/followers JSON found inside ${file.name}.`);
        }
      } catch {
        throw new Error(`Could not open ${file.name}. If this is an Instagram export, try selecting the ZIP again.`);
      }
      continue;
    }

    const name = displayNameForFile(file);
    if (!isRelationshipJsonName(name) && !isRelationshipJsonName(file.name)) {
      // Skip media / unrelated export files when a whole folder is dropped.
      continue;
    }

    try {
      const text = await readFileAsText(file);
      entries.push({ name, json: JSON.parse(text) });
    } catch {
      // Not JSON — ignore here; caller reports if nothing usable was found.
    }
  }

  return { entries, notices };
};

const normalizePartKey = (name) => {
  const lower = name.trim().toLowerCase();
  const match = lower.match(/followers[_-]?(\d+)/);
  if (match) return `followers_${Number(match[1])}`;
  // Bare followers.json is treated as part 1
  if (/^followers\.json$/.test(lower)) return 'followers_1';
  return lower;
};

const partLabel = (part) => part.name;

const upsertFollowerParts = (existingParts, incomingParts) => {
  const map = new Map(
    existingParts.map((part) => [normalizePartKey(part.name), part])
  );
  const replaced = [];
  const added = [];
  const unchanged = [];

  // Last duplicate within this batch already collapsed by caller; still upsert safely.
  for (const part of incomingParts) {
    const key = normalizePartKey(part.name);
    if (map.has(key)) {
      const prev = map.get(key);
      // Same part number / name slot — always replace with newest upload
      replaced.push(part.name === prev.name ? part.name : `${prev.name} → ${part.name}`);
    } else {
      added.push(part.name);
    }
    map.set(key, part);
  }

  for (const part of existingParts) {
    const key = normalizePartKey(part.name);
    if (!incomingParts.some((incoming) => normalizePartKey(incoming.name) === key)) {
      unchanged.push(part.name);
    }
  }

  const next = Array.from(map.values()).sort((a, b) => {
    const numA = Number(normalizePartKey(a.name).match(/(\d+)$/)?.[1] || 0);
    const numB = Number(normalizePartKey(b.name).match(/(\d+)$/)?.[1] || 0);
    if (numA !== numB) return numA - numB;
    return a.name.localeCompare(b.name);
  });

  return { next, replaced, added, unchanged };
};

const isChecked = (checkedMap, username) => Boolean(checkedMap[accountKey(username)]);

const clearStoredData = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage disabled (private mode, blocked cookies) — nothing to clean up.
  }
};

/** Migrate older multi-mark storage into a simple checked map. */
const normalizeCheckedMap = (parsed) => {
  const source =
    (parsed.checkedAccounts && typeof parsed.checkedAccounts === 'object' && parsed.checkedAccounts) ||
    (parsed.accountMarks && typeof parsed.accountMarks === 'object' && parsed.accountMarks) ||
    null;
  if (!source) return {};

  const next = {};
  for (const [key, mark] of Object.entries(source)) {
    if (mark === true || mark?.dealt || mark?.publicProfile || mark?.falsePositive) {
      next[accountKey(key)] = true;
    }
  }
  return next;
};

export default function App() {
  const inputRef = useRef(null);
  const [followingRaw, setFollowingRaw] = useState(null);
  const [followingName, setFollowingName] = useState('');
  const [followersParts, setFollowersParts] = useState([]); // [{ name, raw }]
  const followersPartsRef = useRef([]);
  const [checkedAccounts, setCheckedAccounts] = useState({}); // { [username]: true }
  const [hideChecked, setHideChecked] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    followersPartsRef.current = followersParts;
  }, [followersParts]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.followingRaw) {
          setFollowingRaw(parsed.followingRaw);
          setFollowingName(parsed.followingName || 'following.json');
        }
        if (Array.isArray(parsed.followersParts) && parsed.followersParts.length) {
          const parts = parsed.followersParts
            .filter((part) => part?.name && part?.raw != null)
            .map((part) => ({ name: part.name, raw: part.raw }));
          followersPartsRef.current = parts;
          setFollowersParts(parts);
        } else if (parsed.followersRaw) {
          // Migrate v1 single-file storage
          const parts = [
            {
              name: parsed.followersName || 'followers_1.json',
              raw: parsed.followersRaw,
            },
          ];
          followersPartsRef.current = parts;
          setFollowersParts(parts);
        }
        const migratedChecked = normalizeCheckedMap(parsed);
        if (Object.keys(migratedChecked).length) {
          setCheckedAccounts(migratedChecked);
        }
        if (typeof parsed.hideChecked === 'boolean') {
          setHideChecked(parsed.hideChecked);
        } else if (parsed.hideDealt || parsed.hideFalsePositives) {
          setHideChecked(true);
        }
      }
    } catch {
      clearStoredData();
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (!followingRaw && followersParts.length === 0 && Object.keys(checkedAccounts).length === 0) {
        clearStoredData();
        setStorageWarning('');
        return;
      }
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: STORAGE_VERSION,
          followingRaw,
          followingName,
          followersParts,
          checkedAccounts,
          hideChecked,
        })
      );
      setStorageWarning('');
    } catch {
      // Large exports can exceed the ~5MB localStorage budget. Drop the stale copy so a
      // reload never restores a partial set of parts, and keep working in-memory.
      clearStoredData();
      setStorageWarning(
        'These files are too large to save in this browser, so the comparison below works now but will be cleared on refresh. Re-upload every part after reloading.'
      );
    }
  }, [followingRaw, followingName, followersParts, checkedAccounts, hideChecked, hydrated]);

  const following = useMemo(
    () => (followingRaw ? parseFollowing(followingRaw) : []),
    [followingRaw]
  );

  const followers = useMemo(
    () => mergeFollowerAccounts(followersParts),
    [followersParts]
  );

  const followersPartNames = useMemo(
    () => sortFollowerPartNames(followersParts.map((part) => part.name)),
    [followersParts]
  );

  const notFollowingBack = useMemo(() => {
    if (!following.length || !followers.length) return [];
    const followerSet = new Set(followers.map((f) => f.username.toLowerCase()));
    return following.filter((f) => !followerSet.has(f.username.toLowerCase()));
  }, [following, followers]);

  const visibleAccounts = useMemo(() => {
    return notFollowingBack.filter((account) => {
      if (hideChecked && isChecked(checkedAccounts, account.username)) return false;
      return true;
    });
  }, [notFollowingBack, checkedAccounts, hideChecked]);

  const checkedCount = useMemo(
    () => notFollowingBack.filter((account) => isChecked(checkedAccounts, account.username)).length,
    [notFollowingBack, checkedAccounts]
  );

  const toggleChecked = useCallback((username) => {
    const key = accountKey(username);
    setCheckedAccounts((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }, []);

  const handleFiles = useCallback(async (fileList) => {
    const allFiles = Array.from(fileList || []);

    if (!allFiles.length) {
      setNotice('');
      setError('No files selected.');
      return;
    }

    setError('');
    setNotice('');

    const errors = [];
    const notices = [];

    let entries = [];
    try {
      const expanded = await expandSelectedFiles(allFiles);
      entries = expanded.entries;
      notices.push(...expanded.notices);
    } catch (err) {
      setError(err.message || 'Failed to read the selected files.');
      return;
    }

    if (!entries.length) {
      setError('Could not find following.json or followers_N.json. Upload the ZIP, those JSON files, or the unzipped export folder.');
      return;
    }

    const resolvedFollowing = [];
    const resolvedFollowers = [];

    for (const { name, json } of entries) {
      try {
        const kind = detectKind(name, json);

        if (kind === 'ignored') {
          // Quietly skip unrelated Instagram relationship exports found in a ZIP.
          continue;
        }

        if (kind === 'following') {
          const parsed = parseFollowing(json);
          if (!parsed.length) {
            errors.push(`No following accounts found in ${name}.`);
            continue;
          }
          resolvedFollowing.push({ name, raw: json });
        } else if (kind === 'followers') {
          const parsed = parseFollowers(json);
          if (!parsed.length) {
            errors.push(`No followers found in ${name}.`);
            continue;
          }
          resolvedFollowers.push({ name, raw: json });
        } else if (kind === 'mismatch') {
          errors.push(
            `${name} looks named like a following/followers export, but the contents don't match Instagram's relationship format.`
          );
        }
        // Other JSON in a ZIP (profile, settings, etc.) is ignored quietly.
      } catch (err) {
        errors.push(err.message || `Failed to process ${name}.`);
      }
    }

    if (!resolvedFollowing.length && !resolvedFollowers.length) {
      setError(
        errors[0] ||
          'No following.json or followers_N.json found. Upload the ZIP, those JSON files, or the unzipped export folder.'
      );
      if (notices.length) setNotice(notices.join(' '));
      return;
    }

    if (resolvedFollowing.length) {
      if (resolvedFollowing.length > 1) {
        const names = resolvedFollowing.map((item) => item.name).join(', ');
        notices.push(
          `Multiple following files were uploaded (${names}). Instagram normally provides one following.json — using ${resolvedFollowing[resolvedFollowing.length - 1].name}.`
        );
      }
      const chosen = resolvedFollowing[resolvedFollowing.length - 1];
      if (followingName && followingName === chosen.name) {
        notices.push(`Re-uploaded ${chosen.name} — following data was replaced.`);
      } else if (followingName) {
        notices.push(`Replaced previous following file (${followingName}) with ${chosen.name}.`);
      }
      setFollowingRaw(chosen.raw);
      setFollowingName(chosen.name);
    }

    if (resolvedFollowers.length) {
      // Collapse duplicate part numbers within this single drop (last wins)
      const batchMap = new Map();
      const batchDupes = [];
      for (const part of resolvedFollowers) {
        const key = normalizePartKey(part.name);
        if (batchMap.has(key)) batchDupes.push(part.name);
        batchMap.set(key, part);
      }
      const batchParts = Array.from(batchMap.values());

      if (batchDupes.length) {
        notices.push(
          `Same followers part uploaded more than once in this drop (${batchDupes.join(', ')}); kept the last copy of each.`
        );
      }

      const prev = followersPartsRef.current;
      const { next, replaced, added, unchanged } = upsertFollowerParts(prev, batchParts);
      followersPartsRef.current = next;
      setFollowersParts(next);

      const finalNames = sortFollowerPartNames(next.map(partLabel));

      if (batchParts.length > 1) {
        notices.push(
          `Processed ${batchParts.length} followers parts in this upload: ${sortFollowerPartNames(batchParts.map(partLabel)).join(', ')}.`
        );
      }
      if (replaced.length) {
        notices.push(
          `Replaced existing part${replaced.length > 1 ? 's' : ''}: ${replaced.join(', ')}.`
        );
      }
      if (added.length && prev.length > 0) {
        notices.push(`Added new part${added.length > 1 ? 's' : ''}: ${added.join(', ')}.`);
      }
      if (unchanged.length && (replaced.length || added.length)) {
        notices.push(`Kept previously loaded: ${sortFollowerPartNames(unchanged).join(', ')}.`);
      }
      if (finalNames.length > 1) {
        notices.push(`Followers merged from ${finalNames.length} files: ${finalNames.join(', ')}.`);
      }
    }

    if (notices.length) setNotice(notices.join(' '));
    if (errors.length) setError(errors.join(' '));
  }, [followingName]);

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragging(false);
  };

  const onDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    try {
      const files = await collectDroppedFiles(e.dataTransfer);
      handleFiles(files);
    } catch {
      handleFiles(e.dataTransfer.files);
    }
  };

  const clearData = () => {
    setFollowingRaw(null);
    setFollowingName('');
    followersPartsRef.current = [];
    setFollowersParts([]);
    setCheckedAccounts({});
    setHideChecked(false);
    setError('');
    setNotice('');
    setStorageWarning('');
    clearStoredData();
  };

  const bothLoaded = following.length > 0 && followers.length > 0;
  const hasAnyData = Boolean(followingName || followersParts.length || Object.keys(checkedAccounts).length);

  return (
    <div className="w-full max-w-3xl md:max-w-4xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl animation-fade-in">
      <div className="bg-slate-900 rounded-xl sm:rounded-2xl p-4 sm:p-8 md:p-10 shadow-sm border border-slate-700/80">
        <header className="mb-6 sm:mb-8">
          <h1 className="text-[1.65rem] leading-tight sm:text-3xl md:text-4xl font-bold tracking-tight text-slate-50 mb-2 sm:mb-3">
            Who Doesn&apos;t Follow Back
          </h1>
          <p className="text-[0.95rem] sm:text-lg text-slate-400 leading-relaxed max-w-3xl xl:max-w-none">
            Upload your Instagram export ZIP, folder, or following/followers JSON to see who doesn&apos;t follow you back.
          </p>
        </header>

        <aside className="mb-5 sm:mb-6 rounded-xl sm:rounded-2xl border border-emerald-700/40 bg-emerald-950/35 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Shield size={20} className="text-emerald-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-emerald-100">Your data never leaves this device</h2>
              <p className="text-[13px] sm:text-sm text-emerald-100/80 mt-1.5 leading-relaxed">
                I don&apos;t collect, store, or transmit any of your information. There is no server and no database behind this tool — the ZIP is opened and compared entirely in your browser&apos;s local memory. I have no access to your Instagram account, your export file, or the results on this page.
              </p>
            </div>
          </div>
        </aside>

        <aside className="mb-5 sm:mb-8 rounded-xl sm:rounded-2xl border border-amber-700/50 bg-amber-950/40 overflow-hidden">
          <button
            type="button"
            onClick={() => setWarningOpen((open) => !open)}
            aria-expanded={warningOpen}
            className="w-full flex items-start gap-3 p-4 sm:p-5 md:p-6 text-left hover:bg-amber-900/30 active:bg-amber-900/50 transition-colors min-h-[44px]"
          >
            <AlertTriangle size={20} className="text-amber-400 flex-shrink-0 mt-0.5 sm:w-[22px] sm:h-[22px]" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm sm:text-base font-bold text-amber-100">Results can be inaccurate</h2>
                <ChevronDown
                  size={20}
                  className={`text-amber-400 flex-shrink-0 transition-transform duration-200 ${
                    warningOpen ? 'rotate-180' : ''
                  }`}
                />
              </div>
              <p className="text-[13px] sm:text-sm text-amber-200/80 mt-1 leading-relaxed">
                This tool only does a username comparison of Instagram&apos;s export snapshot. Treat the list as a starting point — not proof that someone deliberately doesn&apos;t follow you, unfollowed you, or blocked you.
              </p>
            </div>
          </button>
          {warningOpen && (
            <ul className="space-y-2.5 text-[13px] sm:text-sm text-amber-100/85 leading-relaxed px-4 sm:px-5 md:px-6 pb-4 sm:pb-5 md:pb-6 pt-0 pl-4 sm:pl-14 md:pl-[3.75rem]">
              <li>
                <span className="font-semibold">Point-in-time snapshot:</span> Exports reflect Instagram&apos;s data when the download was generated (often hours after you request it), not a live feed. Relationships can change before you open the files.
              </li>
              <li>
                <span className="font-semibold">Username changes:</span> Comparisons use handles, not stable user IDs. If someone renamed their account, they can look like two different people — or disappear from one list and appear under a new name.
              </li>
              <li>
                <span className="font-semibold">Deleted, deactivated, or suspended accounts:</span> These may still show in your following list while being missing from followers (or the reverse), which falsely inflates &quot;not following back.&quot;
              </li>
              <li>
                <span className="font-semibold">Blocked or restricted accounts:</span> Blocks, restrict/hide modes, safety holds, parental controls, and region-limited profiles are not clearly labeled. They can be omitted from one list and still look like a normal non-followback.
              </li>
              <li>
                <span className="font-semibold">Split follower files:</span> Large accounts are paginated into <code className="bg-amber-900/60 px-1 rounded">followers_1.json</code>, <code className="bg-amber-900/60 px-1 rounded">followers_2.json</code>, etc. This tool merges every part you upload; missing parts still make real followers look like they don&apos;t follow you.
              </li>
              <li>
                <span className="font-semibold">Pending requests &amp; other exports:</span> Files like pending/recent requests, blocked, restricted, or recently unfollowed are ignored here — they are not the followers list. Private-account quirks and Instagram omissions can still skew the diff.
              </li>
              <li>
                <span className="font-semibold">Export quirks:</span> Meta has changed JSON shapes before, and some exports include inactive/closed accounts in following. Always verify important profiles in the Instagram app before unfollowing.
              </li>
            </ul>
          )}
        </aside>

        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`mb-4 flex flex-col items-center justify-center gap-3 rounded-xl sm:rounded-2xl border-2 border-dashed px-4 py-8 sm:px-6 sm:py-12 text-center transition-colors cursor-pointer select-none ${
            isDragging
              ? 'border-blue-500 bg-blue-950/50'
              : 'border-slate-600 bg-slate-800/60 hover:border-blue-500 hover:bg-blue-950/30 active:bg-blue-950/50'
          }`}
        >
          <div
            className={`rounded-full p-3 ${
              isDragging
                ? 'bg-blue-900 text-blue-300'
                : 'bg-slate-700 text-slate-400 shadow-sm'
            }`}
          >
            <Upload size={26} className="sm:w-7 sm:h-7" />
          </div>
          <div className="px-1">
            <p className="text-base sm:text-lg font-semibold text-slate-100">
              <span className="sm:hidden">{isDragging ? 'Drop files here' : 'Tap to upload your export'}</span>
              <span className="hidden sm:inline">{isDragging ? 'Drop files here' : 'Drag & drop your export'}</span>
            </p>
            <p className="text-xs sm:text-sm text-slate-400 mt-1.5 leading-relaxed">
              <span className="sm:hidden">ZIP, folder, or following/followers JSON</span>
              <span className="hidden sm:inline">ZIP, unzipped folder, or following/followers JSON files</span>
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".json,.zip,application/json,application/zip,application/x-zip-compressed,text/plain,application/octet-stream,*/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              // Copy immediately — clearing the input can empty the live FileList on iOS.
              handleFiles(files ? Array.from(files) : []);
              e.target.value = '';
            }}
          />
        </div>

        <div className="flex flex-col gap-3 mb-5 sm:mb-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1.5 text-xs sm:text-sm min-w-0 break-words">
            <span className="inline-flex items-center gap-2 text-slate-300">
              {followingName ? (
                <>
                  <CheckCircle2 size={16} className="text-green-400 flex-shrink-0" />
                  <span className="truncate">{followingName}</span>
                </>
              ) : (
                <span className="text-slate-500">Following pending</span>
              )}
            </span>
            {followersPartNames.length > 0 ? (
              <span className="inline-flex items-start gap-2 text-slate-300">
                <CheckCircle2 size={16} className="text-green-400 flex-shrink-0 mt-0.5" />
                <span className="break-words">
                  {followersPartNames.length === 1
                    ? followersPartNames[0]
                    : `${followersPartNames.length} followers parts merged: ${followersPartNames.join(', ')}`}
                </span>
              </span>
            ) : (
              <span className="text-slate-500">Followers pending</span>
            )}
          </div>

          {hasAnyData && (
            <button
              type="button"
              onClick={clearData}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-3 -ml-3 sm:ml-0 text-sm text-slate-400 hover:text-red-400 active:text-red-300 transition-colors self-start"
            >
              <Trash2 size={16} />
              Clear saved data
            </button>
          )}
        </div>

        {notice && (
          <div className="mb-3 sm:mb-4 rounded-xl border border-amber-800/60 bg-amber-950/50 px-3.5 py-3 text-[13px] sm:text-sm text-amber-200 break-words">
            {notice}
          </div>
        )}

        {storageWarning && (
          <div className="mb-3 sm:mb-4 rounded-xl border border-amber-700/60 bg-amber-950/50 px-3.5 py-3 text-[13px] sm:text-sm text-amber-200 break-words">
            {storageWarning}
          </div>
        )}

        {error && (
          <div className="mb-5 sm:mb-6 rounded-xl border border-red-900/60 bg-red-950/40 px-3.5 py-3 text-[13px] sm:text-sm text-red-300 break-words">
            {error}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-6 sm:mb-10">
          <div className="p-2.5 sm:p-4 bg-slate-800/80 rounded-xl min-w-0">
            <div className="flex items-center gap-1 sm:gap-2 text-slate-400 mb-1 sm:mb-2">
              <Users size={14} className="flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
              <span className="text-[10px] sm:text-sm font-medium truncate">Following</span>
            </div>
            <p className="text-lg sm:text-2xl font-bold text-slate-50 tabular-nums">{following.length}</p>
          </div>
          <div className="p-2.5 sm:p-4 bg-slate-800/80 rounded-xl min-w-0">
            <div className="flex items-center gap-1 sm:gap-2 text-slate-400 mb-1 sm:mb-2">
              <Users size={14} className="flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
              <span className="text-[10px] sm:text-sm font-medium truncate">Followers</span>
            </div>
            <p className="text-lg sm:text-2xl font-bold text-slate-50 tabular-nums">{followers.length}</p>
            {followersPartNames.length > 1 && (
              <p className="text-[10px] sm:text-xs text-slate-500 mt-0.5 sm:mt-1">from {followersPartNames.length} files</p>
            )}
          </div>
          <div className="p-2.5 sm:p-4 bg-slate-800/80 rounded-xl min-w-0">
            <div className="flex items-center gap-1 sm:gap-2 text-slate-400 mb-1 sm:mb-2">
              <UserX size={14} className="flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
              <span className="text-[10px] sm:text-sm font-medium leading-tight">Not back</span>
            </div>
            <p className="text-lg sm:text-2xl font-bold text-slate-50 tabular-nums">
              {bothLoaded ? notFollowingBack.length : '—'}
            </p>
          </div>
        </div>

        <section>
          <div className="flex flex-col gap-3 mb-3 sm:mb-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-lg sm:text-2xl font-bold text-slate-50 leading-snug">
                Accounts not following you back
              </h2>
              {bothLoaded && notFollowingBack.length > 0 && (
                <p className="text-xs sm:text-sm text-slate-400 mt-1">
                  {notFollowingBack.length - checkedCount} open · {checkedCount} checked
                </p>
              )}
            </div>
            {bothLoaded && notFollowingBack.length > 0 && (
              <label className="inline-flex items-center gap-2.5 text-sm text-slate-300 cursor-pointer select-none min-h-[44px] sm:min-h-0">
                <input
                  type="checkbox"
                  checked={hideChecked}
                  onChange={(e) => setHideChecked(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-500 bg-slate-800 text-soft-accent focus:ring-soft-accent"
                />
                Hide checked
              </label>
            )}
          </div>

          {!bothLoaded && (
            <p className="text-sm sm:text-base text-slate-400 leading-relaxed">
              Upload your Instagram export to generate the list. Previous uploads are restored from local storage when available.
            </p>
          )}

          {bothLoaded && notFollowingBack.length === 0 && (
            <p className="text-sm sm:text-base text-slate-400">Everyone you follow follows you back.</p>
          )}

          {bothLoaded && notFollowingBack.length > 0 && visibleAccounts.length === 0 && (
            <p className="text-sm sm:text-base text-slate-400">
              All accounts are hidden. Turn off &quot;Hide checked&quot; to see them again.
            </p>
          )}

          {bothLoaded && visibleAccounts.length > 0 && (
            <ul className="divide-y divide-slate-700/80 border border-slate-700/80 rounded-xl overflow-hidden">
              {visibleAccounts.map((account) => {
                const checked = isChecked(checkedAccounts, account.username);
                return (
                  <li
                    key={account.username}
                    className={`flex items-center gap-2.5 sm:gap-3 px-3 sm:px-4 py-3 min-h-[52px] transition-colors ${
                      checked
                        ? 'bg-green-950/50 hover:bg-green-950/70'
                        : 'hover:bg-slate-800/80 active:bg-slate-800'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleChecked(account.username)}
                      aria-pressed={checked}
                      aria-label={checked ? `Uncheck @${account.username}` : `Check @${account.username}`}
                      className={`flex-shrink-0 w-10 h-10 sm:w-8 sm:h-8 rounded-lg border-2 flex items-center justify-center transition-colors ${
                        checked
                          ? 'border-green-600 bg-green-600 text-white'
                          : 'border-slate-500 bg-slate-800 text-transparent hover:border-green-400'
                      }`}
                    >
                      <Check size={18} strokeWidth={2.5} />
                    </button>

                    <span
                      className={`font-medium text-[15px] sm:text-base truncate flex-1 min-w-0 ${
                        checked ? 'text-green-100' : 'text-slate-100'
                      }`}
                    >
                      @{account.username}
                    </span>

                    <a
                      href={account.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-1.5 min-h-[44px] px-2 sm:min-h-0 sm:px-0 text-sm text-blue-400 hover:text-blue-300 active:text-blue-200 flex-shrink-0"
                    >
                      <span className="sr-only sm:not-sr-only">Profile</span>
                      <ExternalLink size={16} className="sm:w-[14px] sm:h-[14px]" aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
