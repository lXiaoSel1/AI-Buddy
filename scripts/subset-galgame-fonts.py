"""Build offline Galgame font subsets from the pinned Google Fonts source binaries."""
from argparse import ArgumentParser
from hashlib import file_digest
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

SOURCE_HASHES = {
    'NotoSerifSC.ttf': '050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9',
    'CormorantGaramond-Italic.ttf': '0f48ea6abb2084537854f7174c470991a463b13036309e3b50a81511611c530d',
}


def gb2312():
    for first in range(0xA1, 0xF8):
        for second in range(0xA1, 0xFF):
            try:
                yield ord(bytes((first, second)).decode('gb2312'))
            except UnicodeDecodeError:
                continue


def font_subset(source, destination, codepoints, weight):
    with source.open('rb') as stream:
        if file_digest(stream, 'sha256').hexdigest() != SOURCE_HASHES[source.name]:
            raise ValueError(f'Unexpected upstream font: {source.name}')
    with TTFont(source, recalcTimestamp=False) as font:
        # Load variable-glyph entries before subsetting changes their order.
        font['gvar'].variations = dict(font['gvar'].variations)
        options = subset.Options()
        options.name_IDs = ['*']
        options.name_languages = ['*']
        builder = subset.Subsetter(options)
        builder.populate(unicodes=codepoints)
        builder.subset(font)
        instantiateVariableFont(font, {'wght': weight}, inplace=True)
        font.flavor = 'woff2'
        font.save(destination)
        print(f'{destination.name}: {destination.stat().st_size} bytes, {len(font.getBestCmap())} codepoints')


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Directory of pinned Google Fonts TTF source files')
    parser.add_argument('destination', type=Path, help='Directory for the two WOFF2 subsets')
    args = parser.parse_args()
    punctuation = set(range(0x2000, 0x2070))
    latin = set(range(0x20, 0x250)) | punctuation
    cjk = latin | set(gb2312()) | set(range(0x3000, 0x3040)) | set(range(0xFF00, 0xFFEF))
    font_subset(args.source / 'NotoSerifSC.ttf', args.destination / 'noto-serif-sc.woff2', cjk, (400, 700))
    font_subset(args.source / 'CormorantGaramond-Italic.ttf', args.destination / 'cormorant-garamond-italic.woff2', latin, 500)


if __name__ == '__main__':
    main()
