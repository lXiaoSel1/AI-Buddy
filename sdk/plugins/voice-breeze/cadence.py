"""Delivery guidance for internal sentence boundaries; does not split or alter text."""
import re

CADENCE = '保留原有语速和情绪，不要为了连贯而赶读。逗号短暂停顿，完整句号后留出明显的换气时间；转入新话题时稍停久一点。句尾从容收住，下一句平稳接起，不突然加速或拔高音调。'


def with_cadence(text, instruction):
    # A final full stop/question mark alone is not an internal sentence boundary.
    # Also skip paired punctuation around quoted sentences when finding following text.
    for ending in re.finditer(r'[。！？!?]+', text):
        following = text[ending.end():].strip(' \r\n\t。！？!?…“”‘’「」『』（）()"\'')
        if following:
            return instruction + CADENCE
    return instruction
