"""
Download WeChatFerry release from GitHub mirror (for China users).
Skips connectivity checks and directly uses mirror.
"""
import requests
import sys
import os
import json

DOWNLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "downloads", "wcf")
GITHUB_API = "https://api.github.com/repos/lich0821/WeChatFerry/releases"

# Mirror prefixes for downloading GitHub release assets
MIRROR_PREFIXES = [
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://mirror.ghproxy.com/",
]


def download_file(session, url, dest_path):
    """Download a file with progress."""
    print(f"  URL: {url[:100]}...")
    r = session.get(url, stream=True, timeout=300, allow_redirects=True)
    r.raise_for_status()
    total = int(r.headers.get('content-length', 0))
    downloaded = 0
    with open(dest_path, 'wb') as f:
        for chunk in r.iter_content(chunk_size=65536):
            f.write(chunk)
            downloaded += len(chunk)
            if total > 0:
                pct = downloaded * 100 // total
                mb_done = downloaded / 1024 / 1024
                mb_total = total / 1024 / 1024
                sys.stdout.write(f"\r  Progress: {pct}% ({mb_done:.1f}MB / {mb_total:.1f}MB)   ")
                sys.stdout.flush()
    print()


def main():
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})

    print("[1/2] Fetching release info via mirror...")
    
    latest = None
    # Try fetching API through mirrors
    api_urls = [
        prefix + GITHUB_API.replace("https://", "https://") 
        for prefix in MIRROR_PREFIXES
    ] + [GITHUB_API]
    
    # Actually for API, try the mirror approach differently
    # ghfast mirrors the raw github URLs
    api_mirror_urls = [
        "https://ghfast.top/" + GITHUB_API,
        GITHUB_API,
    ]
    
    for url in api_mirror_urls:
        try:
            print(f"  Trying: {url[:60]}...")
            r = session.get(url, timeout=15)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list) and len(data) > 0:
                    latest = data[0]
                    print(f"  ✅ Success!")
                    break
        except Exception as e:
            print(f"  ❌ Failed: {type(e).__name__}: {e}")
            continue

    if not latest:
        print("\n❌ Cannot fetch release info. Network issue.")
        print("   Please enable VPN/proxy and retry.")
        print("   Or manually download from: https://github.com/lich0821/WeChatFerry/releases")
        sys.exit(1)

    print(f"\n  Release: {latest['tag_name']} - {latest['name']}")
    print(f"  Published: {latest['published_at']}")
    
    assets = latest.get('assets', [])
    print(f"  Assets ({len(assets)}):")
    for i, asset in enumerate(assets):
        size_mb = asset['size'] / 1024 / 1024
        print(f"    [{i}] {asset['name']} ({size_mb:.1f} MB)")

    # Print release body (contains WeChat version info)
    body = latest.get('body', '')
    if body:
        print(f"\n  📝 Release Notes:")
        for line in body.split('\n')[:20]:
            print(f"    {line}")

    # Download assets
    print(f"\n[2/2] Downloading to: {DOWNLOAD_DIR}")
    
    for asset in assets:
        dest = os.path.join(DOWNLOAD_DIR, asset['name'])
        if os.path.exists(dest) and os.path.getsize(dest) == asset['size']:
            print(f"  ✅ Already exists: {asset['name']}")
            continue
        
        print(f"\n  📥 {asset['name']} ({asset['size'] / 1024 / 1024:.1f} MB)")
        original_url = asset['browser_download_url']
        downloaded = False
        
        for prefix in MIRROR_PREFIXES:
            mirror_url = prefix + original_url
            try:
                download_file(session, mirror_url, dest)
                downloaded = True
                print(f"  ✅ Done!")
                break
            except Exception as e:
                print(f"  ❌ Mirror failed ({prefix}): {e}")
                if os.path.exists(dest):
                    os.remove(dest)
                continue
        
        if not downloaded:
            # Try direct as last resort
            try:
                download_file(session, original_url, dest)
                print(f"  ✅ Done (direct)!")
            except Exception as e:
                print(f"  ❌ All attempts failed for {asset['name']}: {e}")

    # Save release info
    info_path = os.path.join(DOWNLOAD_DIR, "release-info.json")
    with open(info_path, 'w', encoding='utf-8') as f:
        json.dump({
            "tag": latest['tag_name'],
            "name": latest['name'],
            "published_at": latest['published_at'],
            "body": latest.get('body', ''),
            "assets": [{"name": a['name'], "size": a['size'], "url": a['browser_download_url']} for a in assets]
        }, f, indent=2, ensure_ascii=False)

    print(f"\n{'='*50}")
    print(f"✅ Complete! Files in: {DOWNLOAD_DIR}")
    print(f"\n📋 Next steps:")
    print(f"  1. Check the release notes above for required WeChat version")
    print(f"  2. Install that specific WeChat version (DO NOT update)")
    print(f"  3. Run: pip install wcferry")


if __name__ == "__main__":
    main()
