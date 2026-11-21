package com.deepseek.harness.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class HarnessDocumentTest {
    @Test
    fun sameLivePageKeepsItsIdentityAcrossTokenAndRouteChanges() {
        val original = harnessDocumentIdentity("http://127.0.0.1:3080/?token=first")

        assertEquals(original, harnessDocumentIdentity("http://127.0.0.1:3080/?token=second#conversation"))
        assertNotEquals(original, harnessDocumentIdentity("http://127.0.0.1:3081/"))
    }
}
