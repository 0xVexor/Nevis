use crate::Res;

#[tauri::command]
pub fn deck_pdf_available() -> bool {
    crate::release_features::slides_enabled() && cfg!(target_os = "macos")
}

#[tauri::command]
pub async fn print_deck(
    window: tauri::WebviewWindow,
    title: String,
    width: f64,
    height: f64,
    save: bool,
    pages: usize,
) -> Res<Option<String>> {
    if !crate::release_features::slides_enabled() { return Err("Slides are disabled in this release.".into()); }
    if pages == 0
        || ![width, height]
            .into_iter()
            .all(|size| (72.0..=1440.0).contains(&size))
    {
        return Err("Invalid deck paper size".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (result, wait) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |webview| {
                mac::print(
                    webview,
                    &title,
                    width,
                    height,
                    save.then_some(pages),
                    result,
                );
            })
            .map_err(|error| error.to_string())?;
        wait.await.map_err(|_| "Print view closed".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = title;
        if save {
            return Err("Direct PDF export is unavailable on this platform".into());
        }
        window.print().map_err(|error| error.to_string())?;
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Res;
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, Bool, NSObject, ProtocolObject},
        sel, AnyThread, MainThreadMarker, MainThreadOnly,
    };
    use objc2_app_kit::{
        NSPaperOrientation, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
    };
    use objc2_core_graphics::CGPDFDocument;
    use objc2_foundation::{NSObjectProtocol, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    use std::{ffi::c_void, path::PathBuf};
    use tokio::sync::oneshot::Sender;

    struct PrintJob {
        file: Option<(PathBuf, usize)>,
        result: Sender<Res<Option<String>>>,
        _delegate: Retained<PrintDelegate>,
        _operation: Retained<NSPrintOperation>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "NevisDeckPrintDelegate"]
        #[thread_kind = MainThreadOnly]
        struct PrintDelegate;

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _operation: &NSPrintOperation, success: Bool, context: *mut c_void) {
                // AppKit calls this once for the context we transferred when starting the job.
                let job = unsafe { Box::from_raw(context.cast::<PrintJob>()) };
                let output = match job.file {
                    Some((file, pages)) if success.as_bool() && page_count(&file) == Some(pages) =>
                        Ok(Some(file.to_string_lossy().into_owned())),
                    Some((file, _)) => {
                        let _ = std::fs::remove_file(file);
                        Err("Could not save the deck PDF".into())
                    }
                    None => Ok(None),
                };
                let _ = job.result.send(output);
            }
        }
    );

    fn page_count(file: &std::path::Path) -> Option<usize> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(file.to_str()?));
        let pdf = CGPDFDocument::with_url(Some(NSURL::as_ref(&url)))?;
        Some(CGPDFDocument::number_of_pages(Some(&pdf)))
    }

    pub fn print(
        webview: tauri::webview::PlatformWebview,
        title: &str,
        width: f64,
        height: f64,
        pages: Option<usize>,
        result: Sender<Res<Option<String>>>,
    ) {
        // Tauri supplies this WKWebView on the main thread for the duration of the callback.
        let webview = unsafe { &*webview.inner().cast::<WKWebView>() };
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = result.send(Err("Print view is not on the main thread".into()));
            return;
        };
        let Some(window) = webview.window() else {
            let _ = result.send(Err("Print window closed".into()));
            return;
        };
        if !webview.respondsToSelector(sel!(printOperationWithPrintInfo:)) {
            let _ = result.send(Err("Printing requires macOS 11 or later".into()));
            return;
        }
        let info = NSPrintInfo::init(NSPrintInfo::alloc());
        info.setOrientation(if width > height {
            NSPaperOrientation::Landscape
        } else {
            NSPaperOrientation::Portrait
        });
        info.setPaperSize(NSSize::new(width, height));
        info.setTopMargin(0.0);
        info.setBottomMargin(0.0);
        info.setLeftMargin(0.0);
        info.setRightMargin(0.0);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        info.setScalingFactor(1.0);
        let operation = unsafe { webview.printOperationWithPrintInfo(&info) };
        let file = pages.map(|pages| {
            (
                std::env::temp_dir().join(format!("nevis-deck-{}.pdf", uuid::Uuid::new_v4())),
                pages,
            )
        });
        if let Some((file, _)) = &file {
            let Some(path) = file.to_str() else {
                let _ = result.send(Err("Invalid PDF path".into()));
                return;
            };
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let info = operation.printInfo();
            unsafe {
                info.setJobDisposition(NSPrintSaveJob);
                info.dictionary().setObject_forKey(
                    &*url as &AnyObject,
                    ProtocolObject::from_ref(NSPrintJobSavingURL),
                );
            }
        }
        operation.setJobTitle(Some(&NSString::from_str(title)));
        operation.setShowsPrintPanel(pages.is_none());
        operation.setShowsProgressPanel(false);
        operation.setCanSpawnSeparateThread(true);
        let delegate: Retained<PrintDelegate> =
            unsafe { msg_send![PrintDelegate::alloc(mtm), init] };
        let job = Box::new(PrintJob {
            file,
            result,
            _delegate: delegate.clone(),
            _operation: operation.clone(),
        });
        // WebKit paginates asynchronously. A synchronous run can block its pagination reply.
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                Some(&delegate),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                Box::into_raw(job).cast(),
            );
        }
    }
}
