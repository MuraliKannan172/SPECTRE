from app.voice.text import MAX_SPOKEN_CHARS, speakable


def test_citations_markdown_links_and_as_of_are_not_spoken():
    answer = (
        "## Artemis\n"
        "NASA is **still aiming** for 2028 [3][4], per [the plan](https://nasa.gov/x) [1, 2].\n"
        "- Crew: four astronauts [5–7]\n"
        "See https://example.org/page for more.\n"
        "As of 2026-10-27 22:54"
    )
    assert speakable(answer) == (
        "Artemis NASA is still aiming for 2028, per the plan. Crew: four astronauts See for more."
    )


def test_decimals_and_plain_brackets_survive():
    assert speakable("The rate is 3.75 to 4.00% [range].") == "The rate is 3.75 to 4.00% [range]."


def test_long_answers_are_cut_at_a_word():
    text = "word " * 300
    spoken = speakable(text)
    assert len(spoken) <= MAX_SPOKEN_CHARS
    assert spoken.endswith("word")


def test_nothing_left_to_say_is_empty():
    assert speakable("[1][2]\nAs of today") == ""
    assert speakable("") == ""
