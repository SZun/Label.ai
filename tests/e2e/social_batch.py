"""Run the required public players and retain each site's outcome."""

REQUIRED_PLATFORMS = ("youtube", "tiktok", "facebook", "instagram", "x")


def check_platforms(check):
    results = {}
    for platform in REQUIRED_PLATFORMS:
        try:
            check(platform)
        except (AssertionError, RuntimeError) as error:
            print(f"{platform}: FAIL ({error})", flush=True)
            results[platform] = False
        else:
            results[platform] = True
    print("Live video badge results", flush=True)
    for platform, passed in results.items():
        print(f"  {platform}: {'PASS' if passed else 'FAIL'}", flush=True)
    return results
