package com.deepseek.harness.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Layout shape for the two form factors this app must serve:
 *
 * - **Portrait**: one column. The terminal list and the harness are full-screen
 *   routes; there is no horizontal room to show both.
 * - **Landscape**: two columns. A persistent navigation rail on the left
 *   (terminals + actions) and the harness on the right, so switching terminals
 *   never costs a full-screen navigation.
 *
 * The shape is decided by the window's ASPECT RATIO, not by an absolute width.
 *
 * A width threshold is the wrong tool here: the same 720dp is a comfortable
 * tablet and a cramped phone depending only on how tall the window is, and pick
 * any round number and some device lands 3dp on the wrong side of it — a 717dp
 * phone rotated to landscape was being treated as a phone in portrait. The
 * aspect ratio asks the question that actually matters: "is this window wider
 * than it is tall?", which is exactly the condition under which a permanent
 * side rail costs nothing that the user wanted for the content.
 *
 * There is still a floor, because a rail has to leave a usable column beside
 * it: `rail + the page's own icon rail + a minimum readable chat column`. That
 * floor is derived from those three parts rather than guessed, and it only
 * rejects genuinely tiny windows (a phone split-screened with another app).
 *
 * The decision is made from the WINDOW, not the device screen: on Android 12+ a
 * tablet can run this app in split-screen, where the window is phone-width even
 * though the device is not.
 */
@Immutable
data class FormFactor(
    val isTwoPane: Boolean,
    val compact: Boolean,
    val railWidth: Dp,
    val contentMaxWidth: Dp,
) {
    companion object {
        /** Rail width: enough for a terminal name and its address on one line. */
        private const val RAIL_DP = 264

        /**
         * A window narrower than this cannot hold the rail AND a readable page.
         * Derived, not chosen: 264dp rail + ~64dp of the harness document's own
         * icon rail + 360dp of chat column. It exists only to keep a small
         * split-screen window on the one-column layout.
         */
        private const val TWO_PANE_MIN_WIDTH_DP = RAIL_DP + 64 + 360

        /** Wider than tall — the condition a side rail is actually worth. */
        private const val LANDSCAPE_RATIO = 1.0f

        @Composable
        fun current(): FormFactor {
            val configuration = LocalConfiguration.current
            val widthDp = configuration.screenWidthDp
            val heightDp = configuration.screenHeightDp
            val ratio = if (heightDp > 0) widthDp.toFloat() / heightDp else 0f
            val landscape = ratio > LANDSCAPE_RATIO
            val twoPane = landscape && widthDp >= TWO_PANE_MIN_WIDTH_DP
            return FormFactor(
                isTwoPane = twoPane,
                compact = widthDp < 600,
                railWidth = if (twoPane) RAIL_DP.dp else 0.dp,
                // A reading column wider than ~880dp is uncomfortable for chat
                // text, so the harness gets a centred column on very wide tablets.
                contentMaxWidth = 1080.dp,
            )
        }
    }
}
