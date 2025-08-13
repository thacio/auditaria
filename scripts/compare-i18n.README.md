# i18n Key Comparison Tool

A simple dev tool to compare translation JSON files and identify missing keys.

## Usage

### Direct execution:
```bash
node scripts/compare-i18n.cjs packages/core/src/i18n/locales/en.json packages/core/src/i18n/locales/pt.json
```

### Using npm script:
```bash
npm run i18n:compare packages/core/src/i18n/locales/en.json packages/core/src/i18n/locales/pt.json
```

### From scripts directory:
```bash
cd scripts && node compare-i18n.cjs ../packages/core/src/i18n/locales/en.json ../packages/core/src/i18n/locales/pt.json
```

## Output

The tool provides:
- Keys present in file1 but missing in file2
- Keys present in file2 but missing in file1  
- Total synchronization percentage
- Color-coded terminal output for easy reading

## Exit Codes

- `0` - Files have identical keys
- `1` - Discrepancies found between files

## Example

```bash
# Compare English and Portuguese translations
node scripts/compare-i18n.cjs packages/core/src/i18n/locales/en.json packages/core/src/i18n/locales/pt.json

# Compare all language files against English
for file in packages/core/src/i18n/locales/*.json; do
  if [ "$file" != "packages/core/src/i18n/locales/en.json" ]; then
    echo "Comparing en.json with $(basename $file)..."
    node scripts/compare-i18n.cjs packages/core/src/i18n/locales/en.json "$file"
  fi
done
```